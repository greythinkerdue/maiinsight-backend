import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { seedUsers } from "../src/services/seedUsers.service.js";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loads a static InstaSight snapshot (exported once from a dev database) so
// this environment shows real historical Instagram performance data without
// needing a live Meta access token. Safe to run on every boot: every write
// below is an upsert or a skip-duplicates createMany.
const seedInstasightSnapshot = async (database) => {
  const snapshotPath = path.join(__dirname, "instasight-snapshot.json");
  if (!fs.existsSync(snapshotPath)) return;

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  const { account, media, mediaInsights, snapshots, accountInsights, audienceInsights, monthlyPerformance } = snapshot;

  if (account) {
    await database.instagramAccount.upsert({
      where: { id: account.id },
      update: account,
      create: account,
    });
  }
  if (snapshots?.length) {
    await database.instagramAccountSnapshot.createMany({ data: snapshots, skipDuplicates: true });
  }
  if (media?.length) {
    await database.instagramMedia.createMany({ data: media, skipDuplicates: true });
  }
  if (mediaInsights?.length) {
    await database.instagramMediaInsight.createMany({ data: mediaInsights, skipDuplicates: true });
  }
  if (accountInsights?.length) {
    await database.instagramAccountInsight.createMany({ data: accountInsights, skipDuplicates: true });
  }
  if (audienceInsights?.length) {
    await database.instagramAudienceInsight.createMany({ data: audienceInsights, skipDuplicates: true });
  }
  if (monthlyPerformance?.length) {
    await database.instagramMonthlyMediaPerformance.createMany({ data: monthlyPerformance, skipDuplicates: true });
  }
};

async function main() {
  await seedUsers(prisma);
  await seedInstasightSnapshot(prisma);

  const appSettings = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    GEMINI_ENABLED: process.env.GEMINI_API_KEY ? "true" : "false",
    META_IG_USER_ID: process.env.META_IG_USER_ID || "",
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION || "v25.0",
    META_ENABLED:
      process.env.META_IG_USER_ID && process.env.META_ACCESS_TOKEN ? "true" : "false",
  };

  for (const [key, value] of Object.entries(appSettings)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  await prisma.notification.upsert({
    where: { id: 1 },
    update: {
      title: "Marketing campaign ready",
      message: "Your marketing dashboard is ready. A new campaign is waiting for review.",
      role: "operational",
    },
    create: {
      title: "Marketing campaign ready",
      message: "Your marketing dashboard is ready. A new campaign is waiting for review.",
      role: "operational",
    },
  });

  await prisma.notification.upsert({
    where: { id: 2 },
    update: {
      title: "Status report generated",
      message: "Quarterly status report is now available.",
      role: "management",
    },
    create: {
      title: "Status report generated",
      message: "Quarterly status report is now available.",
      role: "management",
    },
  });

  await prisma.notification.upsert({
    where: { id: 3 },
    update: {
      title: "Server maintenance scheduled",
      message: "IT support will monitor the system tomorrow.",
      role: "it_support",
    },
    create: {
      title: "Server maintenance scheduled",
      message: "IT support will monitor the system tomorrow.",
      role: "it_support",
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
