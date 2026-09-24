-- CreateEnum
CREATE TYPE "ChannelProvider" AS ENUM ('META', 'EVOLUTION');

-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "apiBaseUrl" TEXT,
ADD COLUMN     "provider" "ChannelProvider" NOT NULL DEFAULT 'META',
ADD COLUMN     "webhookTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Channel_webhookTokenHash_key" ON "Channel"("webhookTokenHash");

