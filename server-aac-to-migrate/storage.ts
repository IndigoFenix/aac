import { 
  users, 
  chatHistory, 
  symbols, 
  userSessions,
  adminUsers,
  type User, 
  type InsertUser,
  type ChatHistory,
  type InsertChatHistory,
  type Symbol,
  type InsertSymbol,
  type UserSession,
  type InsertUserSession,
  type AdminUser,
  type InsertAdminUser
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and } from "drizzle-orm";

export interface IStorage {
  // User operations
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, user: Partial<InsertUser>): Promise<User>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: string): Promise<boolean>;
  
  // Chat history operations
  getChatHistory(userId: string, limit?: number): Promise<ChatHistory[]>;
  getChatHistoryByDateRange(userId: string, startDate: Date, endDate: Date): Promise<ChatHistory[]>;
  addChatHistory(chat: InsertChatHistory): Promise<ChatHistory>;
  
  // Symbol operations
  getAllSymbols(): Promise<Symbol[]>;
  getSymbolsByCategory(category: string): Promise<Symbol[]>;
  addSymbol(symbol: InsertSymbol): Promise<Symbol>;
  
  // Session operations
  createSession(session: InsertUserSession): Promise<UserSession>;
  updateSession(id: string, session: Partial<InsertUserSession>): Promise<UserSession>;
  getUserSessions(userId: string): Promise<UserSession[]>;
  
  // Admin operations
  getAdminByUsername(username: string): Promise<AdminUser | undefined>;
  getAdmin(id: string): Promise<AdminUser | undefined>;
  createAdmin(admin: InsertAdminUser): Promise<AdminUser>;
  updateAdmin(id: string, admin: Partial<InsertAdminUser>): Promise<AdminUser>;
  updateAdminLastLogin(id: string): Promise<void>;

  // Password reset operations
  getUserByResetToken(token: string): Promise<User | undefined>;
  updateUserResetToken(userId: string, token: string, expiry: Date): Promise<void>;
  updateUserPassword(userId: string, passwordHash: string): Promise<void>;
  clearUserResetToken(userId: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async updateUser(id: string, userData: Partial<InsertUser>): Promise<User> {
    console.log("DatabaseStorage.updateUser called with:", { id, userData });
    const [user] = await db
      .update(users)
      .set({ ...userData, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    console.log("DatabaseStorage.updateUser result:", user ? "Success" : "No user found");
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  }



  async getAllUsers(): Promise<User[]> {
    return await db.select().from(users).orderBy(desc(users.createdAt));
  }

  async deleteUser(id: string): Promise<boolean> {
    const result = await db.delete(users).where(eq(users.id, id));
    return (result.rowCount || 0) > 0;
  }

  async getChatHistory(userId: string, limit = 50): Promise<ChatHistory[]> {
    return await db
      .select()
      .from(chatHistory)
      .where(eq(chatHistory.userId, userId))
      .orderBy(desc(chatHistory.timestamp))
      .limit(limit);
  }

  async getChatHistoryByDateRange(userId: string, startDate: Date, endDate: Date): Promise<ChatHistory[]> {
    return await db
      .select()
      .from(chatHistory)
      .where(
        and(
          eq(chatHistory.userId, userId),
          and(
            // @ts-ignore - SQL comparison operators work with Date objects
            chatHistory.timestamp >= startDate,
            // @ts-ignore - SQL comparison operators work with Date objects  
            chatHistory.timestamp <= endDate
          )
        )
      )
      .orderBy(chatHistory.timestamp);
  }

  async addChatHistory(chat: InsertChatHistory): Promise<ChatHistory> {
    const [chatRecord] = await db
      .insert(chatHistory)
      .values(chat)
      .returning();
    return chatRecord;
  }

  async getAllSymbols(): Promise<Symbol[]> {
    return await db.select().from(symbols);
  }

  async getSymbolsByCategory(category: string): Promise<Symbol[]> {
    return await db
      .select()
      .from(symbols)
      .where(eq(symbols.category, category));
  }

  async addSymbol(symbol: InsertSymbol): Promise<Symbol> {
    const [newSymbol] = await db
      .insert(symbols)
      .values(symbol)
      .returning();
    return newSymbol;
  }

  async createSession(session: InsertUserSession): Promise<UserSession> {
    const [newSession] = await db
      .insert(userSessions)
      .values(session)
      .returning();
    return newSession;
  }

  async updateSession(id: string, sessionData: Partial<InsertUserSession>): Promise<UserSession> {
    const [session] = await db
      .update(userSessions)
      .set(sessionData)
      .where(eq(userSessions.id, id))
      .returning();
    return session;
  }

  async getUserSessions(userId: string): Promise<UserSession[]> {
    return await db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, userId))
      .orderBy(desc(userSessions.startTime));
  }

  // Admin user operations
  async getAdminByUsername(username: string): Promise<AdminUser | undefined> {
    const [admin] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.username, username));
    return admin;
  }

  async createAdmin(adminData: InsertAdminUser): Promise<AdminUser> {
    const [admin] = await db
      .insert(adminUsers)
      .values(adminData)
      .returning();
    return admin;
  }

  async getAdmin(id: string): Promise<AdminUser | undefined> {
    const [admin] = await db
      .select()
      .from(adminUsers)
      .where(eq(adminUsers.id, id));
    return admin;
  }

  async updateAdmin(id: string, adminData: Partial<InsertAdminUser>): Promise<AdminUser> {
    const [admin] = await db
      .update(adminUsers)
      .set({ ...adminData, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    if (!admin) {
      throw new Error("Admin not found");
    }
    return admin;
  }

  async updateAdminLastLogin(id: string): Promise<void> {
    await db
      .update(adminUsers)
      .set({ lastLogin: new Date() })
      .where(eq(adminUsers.id, id));
  }

  // Password reset methods
  async getUserByResetToken(token: string): Promise<User | undefined> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.resetToken, token));
    return user;
  }

  async updateUserResetToken(userId: string, token: string, expiry: Date): Promise<void> {
    await db
      .update(users)
      .set({ 
        resetToken: token, 
        resetTokenExpiry: expiry,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await db
      .update(users)
      .set({ 
        passwordHash,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
  }

  async clearUserResetToken(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ 
        resetToken: null, 
        resetTokenExpiry: null,
        updatedAt: new Date()
      })
      .where(eq(users.id, userId));
  }
}

export const storage = new DatabaseStorage();
