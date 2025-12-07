import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import bcrypt from "bcryptjs";
import session from "express-session";
import connectPg from "connect-pg-simple";
import type { Express, RequestHandler } from "express";
import { User as SelectUser } from "@shared/schema";
import { storage } from "./storage";
import { pool } from "./db";
import createMemoryStore from "memorystore";

const MemoryStore = createMemoryStore(session);

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

export function getUserSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    pool,
    createTableIfMissing: false,
    ttl: sessionTtl / 1000,   // connect-pg-simple expects seconds, see note below
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key-for-dev',
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: sessionTtl,
    },
  });
}

export async function setupUserAuth(app: Express) {
  app.use(getUserSession());
  app.use(passport.initialize());
  app.use(passport.session());

  // Local Strategy for email/password login
  passport.use(new LocalStrategy(
    {
      usernameField: 'email',
      passwordField: 'password'
    },
    async (email, password, done) => {
      try {
        const user = await storage.getUserByEmail(email);
        if (!user) {
          return done(null, false, { message: 'No account found with this email address' });
        }

        if (user.authProvider === 'google') {
          return done(null, false, { message: 'Please sign in with Google for this account' });
        }

        if (!user.password) {
          return done(null, false, { message: 'Invalid login credentials' });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
          return done(null, false, { message: 'Invalid login credentials' });
        }

        // Update last active time
        await storage.updateUser(user.id, { lastActiveAt: new Date() });

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  ));

  // Google OAuth Strategy (only set up if credentials are provided)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    // Use production domain or fallback to Replit URL for development
    const callbackURL = process.env.GOOGLE_OAUTH_CALLBACK_URL || 
                        "https://communiaacte.xahaph.com/auth/google/callback";
    console.log('Setting up Google OAuth strategy with callback URL:', callbackURL);
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: callbackURL
      },
    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log('Google OAuth strategy callback - profile:', profile.id, profile.emails?.[0]?.value);
        
        // Check if user exists by Google ID
        let user = await storage.getUserByGoogleId(profile.id);
        console.log('Existing user by Google ID:', user ? 'found' : 'not found');
        
        if (user) {
          // Update last active time
          await storage.updateUser(user.id, { lastActiveAt: new Date() });
          console.log('Returning existing Google user:', user.id);
          return done(null, user);
        }

        // Check if user exists by email
        const email = profile.emails?.[0]?.value;
        console.log('Google profile email:', email);
        
        if (email) {
          user = await storage.getUserByEmail(email);
          console.log('Existing user by email:', user ? 'found' : 'not found');
          
          if (user) {
            // Link Google account to existing user
            console.log('Linking Google account to existing user:', user.id);
            // Filter out base64 data URLs that can cause database corruption
            const profileImageUrl = profile.photos?.[0]?.value;
            const validImageUrl = profileImageUrl && (profileImageUrl.startsWith('http://') || profileImageUrl.startsWith('https://')) ? profileImageUrl : null;
            
            await storage.updateUser(user.id, { 
              googleId: profile.id,
              profileImageUrl: validImageUrl,
              lastActiveAt: new Date()
            });
            return done(null, user);
          }
        }

        // Create new user
        if (email) {
          console.log('Creating new Google user for email:', email);
          // Filter out base64 data URLs that can cause database corruption
          const profileImageUrl = profile.photos?.[0]?.value;
          const validImageUrl = profileImageUrl && (profileImageUrl.startsWith('http://') || profileImageUrl.startsWith('https://')) ? profileImageUrl : undefined;
          
          user = await storage.createGoogleUser({
            email,
            firstName: profile.name?.givenName,
            lastName: profile.name?.familyName,
            googleId: profile.id,
            profileImageUrl: validImageUrl
          });
          console.log('Created new Google user:', user.id);
          return done(null, user);
        }

        console.error('No email found in Google profile');
        return done(new Error('No email provided by Google'));
      } catch (error) {
        return done(error);
      }
    }
    ));
  }

  passport.serializeUser((user: any, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
}

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ message: "Authentication required" });
};

export const optionalAuth: RequestHandler = (req, res, next) => {
  // Always proceed, but user info will be available if authenticated
  next();
};

export const requireSLPPlan: RequestHandler = (req, res, next) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ 
      message: "Authentication required",
      error: "not_authenticated" 
    });
  }

  const user = req.user as any;
  
  // Check if user is admin, has SLP/Premium/Enterprise subscription, or is SLP user type
  const hasAccess = 
    user.isAdmin ||
    user.userType === 'SLP' ||
    user.userType === 'Admin' ||
    user.subscriptionType === 'premium' ||
    user.subscriptionType === 'enterprise';

  if (!hasAccess) {
    return res.status(403).json({ 
      message: "Clinical data access requires SLP or Premium subscription",
      error: "subscription_required",
      requiredPlan: "SLP/Premium/Enterprise"
    });
  }

  next();
};

export async function validateCredits(userId: string): Promise<{ hasCredits: boolean; credits: number }> {
  const user = await storage.getUser(userId);
  if (!user) {
    return { hasCredits: false, credits: 0 };
  }
  return { hasCredits: user.credits > 0, credits: user.credits };
}

export async function deductCredit(userId: string, description: string = 'Interpretation usage'): Promise<boolean> {
  try {
    const user = await storage.getUser(userId);
    if (!user || user.credits <= 0) {
      return false;
    }

    await storage.updateUserCredits(userId, -1, 'usage', description);
    return true;
  } catch (error) {
    console.error('Error deducting credit:', error);
    return false;
  }
}