/**
 * Health Check Endpoint Example
 * 
 * Add this to your Express server to support ALB health checks
 * This endpoint should be accessible without authentication
 * 
 * File: server/routes/health.ts (or add to your existing routes)
 */

import { Router, Request, Response } from 'express';

const router = Router();

/**
 * Basic health check - returns 200 if server is running
 * Used by: ALB target group health checks, ECS container health checks
 * 
 * IMPORTANT: This must be mounted BEFORE auth middleware at /health
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Detailed health check - includes database connectivity
 * Used by: Monitoring dashboards, detailed diagnostics
 * 
 * NOTE: This endpoint might be slower due to DB check
 * Consider using /health for ALB checks and /health/detailed for monitoring
 */
router.get('/health/detailed', async (_req: Request, res: Response) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: { status: 'unknown' as string, latency: 0 },
      memory: { 
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB'
      }
    }
  };

  try {
    // Database health check
    const dbStart = Date.now();
    
    // Replace with your actual database check
    // Example with Drizzle:
    // await db.execute(sql`SELECT 1`);
    
    // Example with raw pg:
    // await pool.query('SELECT 1');
    
    health.checks.database = {
      status: 'healthy',
      latency: Date.now() - dbStart
    };
  } catch (error) {
    health.status = 'degraded';
    health.checks.database = {
      status: 'unhealthy',
      latency: 0
    };
    // Don't expose error details in production
    console.error('Database health check failed:', error);
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Readiness check - returns 200 when app is ready to serve traffic
 * Used by: Kubernetes/ECS readiness probes
 */
router.get('/ready', (_req: Request, res: Response) => {
  // Add any startup checks here
  // For example, check if database connection pool is initialized
  
  res.status(200).json({
    ready: true,
    timestamp: new Date().toISOString()
  });
});

export default router;

/**
 * Usage in your main Express app:
 * 
 * import healthRouter from './routes/health';
 * 
 * // Mount health check BEFORE any authentication middleware
 * // so ALB can check health without auth
 * app.use(healthRouter);  // This registers /health and /health/detailed
 * 
 * // Then add your authenticated routes
 * app.use('/auth', authRoutes);      // Login, register, etc.
 * app.use('/api', authMiddleware, protectedRoutes);  // Protected API routes
 */
