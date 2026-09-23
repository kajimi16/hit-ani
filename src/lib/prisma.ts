import { PrismaClient } from "@prisma/client";

/**
 * 开发环境 HMR 会重复求值模块，用 globalThis 兜住单例。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
