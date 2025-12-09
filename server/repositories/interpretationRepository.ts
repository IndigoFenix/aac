import {
  interpretations,
  users,
  type Interpretation,
  type InsertInterpretation,
} from "@shared/schema";
import { db } from "../db";
import { eq, desc, count, and, sql } from "drizzle-orm";

export class InterpretationRepository {
  async createInterpretation(
    insertInterpretation: InsertInterpretation
  ): Promise<Interpretation> {
    const [interpretation] = await db
      .insert(interpretations)
      .values(insertInterpretation)
      .returning();
    return interpretation;
  }

  async getInterpretations(limit?: number): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .orderBy(desc(interpretations.createdAt));
    return limit ? await query.limit(limit) : await query;
  }

  async getInterpretationsByUser(
    userId: string,
    limit?: number
  ): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .where(eq(interpretations.userId, userId))
      .orderBy(desc(interpretations.createdAt));
    return limit ? await query.limit(limit) : await query;
  }

  async getInterpretation(id: string): Promise<Interpretation | undefined> {
    const [interpretation] = await db
      .select()
      .from(interpretations)
      .where(eq(interpretations.id, id));
    return interpretation || undefined;
  }

  async getAllInterpretationsWithUsers(
    limit?: number
  ): Promise<
    (Interpretation & {
      user: { id: string; email: string; fullName: string | null } | null;
    })[]
  > {
    const query = db
      .select({
        id: interpretations.id,
        userId: interpretations.userId,
        originalInput: interpretations.originalInput,
        interpretedMeaning: interpretations.interpretedMeaning,
        analysis: interpretations.analysis,
        confidence: interpretations.confidence,
        suggestedResponse: interpretations.suggestedResponse,
        inputType: interpretations.inputType,
        language: interpretations.language,
        context: interpretations.context,
        studentId: interpretations.studentId,
        studentName: interpretations.studentName,
        imageData: interpretations.imageData,
        caregiverFeedback: interpretations.caregiverFeedback,
        studentWPM: interpretations.studentWPM,
        scheduleActivity: interpretations.scheduleActivity,
        createdAt: interpretations.createdAt,
        user: {
          id: users.id,
          email: users.email,
          fullName: users.fullName,
        },
      })
      .from(interpretations)
      .leftJoin(users, eq(interpretations.userId, users.id))
      .orderBy(desc(interpretations.createdAt));

    return limit ? await query.limit(limit) : await query;
  }

  async deleteInterpretation(id: string): Promise<boolean> {
    const result = await db
      .delete(interpretations)
      .where(eq(interpretations.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  async getInterpretationsStats(): Promise<{
    total: number;
    today: number;
    thisWeek: number;
  }> {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [totalResult] = await db
      .select({ count: count() })
      .from(interpretations);
    const [todayResult] = await db
      .select({ count: count() })
      .from(interpretations)
      .where(sql`${interpretations.createdAt} >= ${today}`);
    const [weekResult] = await db
      .select({ count: count() })
      .from(interpretations)
      .where(sql`${interpretations.createdAt} >= ${weekAgo}`);

    return {
      total: totalResult.count,
      today: todayResult.count,
      thisWeek: weekResult.count,
    };
  }

  // Clinical data operations
  async getClinicalData(filters: {
    userId?: string;
    studentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<Interpretation[]> {
    const conditions = [];

    if (filters.userId) {
      conditions.push(eq(interpretations.userId, filters.userId));
    }

    if (filters.studentId) {
      conditions.push(eq(interpretations.studentId, filters.studentId));
    }

    if (filters.startDate) {
      conditions.push(
        sql`${interpretations.createdAt} >= ${filters.startDate}`
      );
    }

    if (filters.endDate) {
      conditions.push(sql`${interpretations.createdAt} <= ${filters.endDate}`);
    }

    const query = db.select().from(interpretations);

    if (conditions.length > 0) {
      return await query
        .where(and(...conditions))
        .orderBy(desc(interpretations.createdAt));
    }

    return await query.orderBy(desc(interpretations.createdAt));
  }

  async getClinicalMetrics(filters: {
    userId?: string;
    studentId?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<{
    totalInterpretations: number;
    averageWPM: number | null;
    averageConfidence: number | null;
    acceptanceRate: number | null;
    feedbackCounts: {
      confirmed: number;
      corrected: number;
      rejected: number;
      noFeedback: number;
    };
  }> {
    const data = await this.getClinicalData(filters);

    const totalInterpretations = data.length;

    const wpmValues = data
      .filter((d) => d.studentWPM !== null)
      .map((d) => d.studentWPM as number);
    const averageWPM =
      wpmValues.length > 0
        ? wpmValues.reduce((a, b) => a + b, 0) / wpmValues.length
        : null;

    const averageConfidence =
      data.length > 0
        ? data.reduce((sum, d) => sum + d.confidence, 0) / data.length
        : null;

    const feedbackCounts = {
      confirmed: data.filter((d) => d.caregiverFeedback === "confirmed").length,
      corrected: data.filter((d) => d.caregiverFeedback === "corrected").length,
      rejected: data.filter((d) => d.caregiverFeedback === "rejected").length,
      noFeedback: data.filter((d) => !d.caregiverFeedback).length,
    };

    const totalWithFeedback =
      feedbackCounts.confirmed +
      feedbackCounts.corrected +
      feedbackCounts.rejected;
    const acceptanceRate =
      totalWithFeedback > 0
        ? (feedbackCounts.confirmed / totalWithFeedback) * 100
        : null;

    return {
      totalInterpretations,
      averageWPM,
      averageConfidence,
      acceptanceRate,
      feedbackCounts,
    };
  }

  // Historical AAC analysis
  async getStudentHistory(
    studentId: string,
    limit?: number
  ): Promise<Interpretation[]> {
    const query = db
      .select()
      .from(interpretations)
      .where(eq(interpretations.studentId, studentId))
      .orderBy(desc(interpretations.createdAt));

    return limit ? await query.limit(limit) : await query;
  }

  async analyzeHistoricalPatterns(
    studentId: string,
    currentInput: string
  ): Promise<{
    suggestions: Array<{
      interpretation: string;
      confidence: number;
      frequency: number;
      pattern: string;
    }>;
    totalPatterns: number;
  }> {
    try {
      const history = await this.getStudentHistory(studentId);

      if (history.length === 0) {
        return { suggestions: [], totalPatterns: 0 };
      }

      const normalizeText = (text: string): string[] => {
        return text
          .toLowerCase()
          .replace(/[^\w\s]/g, " ")
          .split(/\s+/)
          .filter((word) => word.length > 0);
      };

      const currentWords = normalizeText(currentInput);

      const patternFrequency = new Map<
        string,
        {
          interpretation: string;
          count: number;
          matchScore: number;
        }
      >();

      for (const record of history) {
        const historicalWords = normalizeText(record.originalInput);
        const matchScore = this.calculateWordSimilarity(currentWords, historicalWords);

        if (matchScore > 0) {
          const pattern = historicalWords.join(" ");
          const existing = patternFrequency.get(pattern);

          if (existing) {
            existing.count++;
            existing.matchScore = Math.max(existing.matchScore, matchScore);
          } else {
            patternFrequency.set(pattern, {
              interpretation: record.interpretedMeaning,
              count: 1,
              matchScore,
            });
          }
        }
      }

      const suggestions = Array.from(patternFrequency.entries())
        .map(([pattern, data]) => ({
          interpretation: data.interpretation,
          confidence: this.calculateConfidence(
            data.matchScore,
            data.count,
            history.length
          ),
          frequency: data.count,
          pattern,
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);

      return {
        suggestions,
        totalPatterns: patternFrequency.size,
      };
    } catch (error) {
      console.error("Error analyzing historical patterns:", error);
      return { suggestions: [], totalPatterns: 0 };
    }
  }

  private calculateWordSimilarity(words1: string[], words2: string[]): number {
    if (words1.length === 0 || words2.length === 0) return 0;

    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    const jaccardSimilarity = intersection.size / union.size;

    let orderBonus = 0;
    const minLength = Math.min(words1.length, words2.length);
    for (let i = 0; i < minLength; i++) {
      if (words1[i] === words2[i]) {
        orderBonus += 0.1;
      }
    }

    return Math.min(jaccardSimilarity + orderBonus, 1.0);
  }

  private calculateConfidence(
    matchScore: number,
    frequency: number,
    totalRecords: number
  ): number {
    const similarityWeight = 0.6;
    const frequencyWeight = 0.4;
    const normalizedFrequency = Math.min(frequency / totalRecords, 1.0);

    return Math.min(
      matchScore * similarityWeight + normalizedFrequency * frequencyWeight,
      1.0
    );
  }
}

export const interpretationRepository = new InterpretationRepository();
