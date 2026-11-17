import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";

export const APP_SETTING_KEYS = {
  GEMINI_API_KEY: "GEMINI_API_KEY",
  GEMINI_MODEL: "GEMINI_MODEL",
  GEMINI_ENABLED: "GEMINI_ENABLED",
  META_IG_USER_ID: "META_IG_USER_ID",
  META_ACCESS_TOKEN: "META_ACCESS_TOKEN",
  META_GRAPH_VERSION: "META_GRAPH_VERSION",
  META_ENABLED: "META_ENABLED",
  WHATSAPP_PHONE_NUMBER_ID: "WHATSAPP_PHONE_NUMBER_ID",
  WHATSAPP_ACCESS_TOKEN: "WHATSAPP_ACCESS_TOKEN",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "WHATSAPP_BUSINESS_ACCOUNT_ID",
  WHATSAPP_TEMPLATE_NAME: "WHATSAPP_TEMPLATE_NAME",
  WHATSAPP_TEMPLATE_LANGUAGE: "WHATSAPP_TEMPLATE_LANGUAGE",
  WHATSAPP_GRAPH_VERSION: "WHATSAPP_GRAPH_VERSION",
  WHATSAPP_ENABLED: "WHATSAPP_ENABLED",
};

const normalizeValue = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

export const readAppSettings = async (keys) => {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
  });

  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return keys.reduce((acc, key) => {
    acc[key] = map[key];
    return acc;
  }, {});
};

export const writeAppSettings = async (entries) => {
  const items = Object.entries(entries).map(([key, value]) =>
    prisma.appSetting.upsert({
      where: { key },
      update: { value: normalizeValue(value) },
      create: { key, value: normalizeValue(value) },
    })
  );

  return prisma.$transaction(items);
};

export const buildConfigSnapshot = async () => {
  const settings = await readAppSettings(Object.values(APP_SETTING_KEYS));
  return {
    geminiApiKey: settings[APP_SETTING_KEYS.GEMINI_API_KEY] ?? env.geminiApiKey,
    geminiModel: settings[APP_SETTING_KEYS.GEMINI_MODEL] ?? env.geminiModel ?? "gemini-1.5-flash",
    geminiEnabled: (settings[APP_SETTING_KEYS.GEMINI_ENABLED] ?? "true") === "true",
    metaIgUserId: settings[APP_SETTING_KEYS.META_IG_USER_ID] ?? env.metaIgUserId,
    metaAccessToken: settings[APP_SETTING_KEYS.META_ACCESS_TOKEN] ?? env.metaAccessToken,
    metaGraphVersion: settings[APP_SETTING_KEYS.META_GRAPH_VERSION] ?? env.metaApiVersion ?? "v25.0",
    metaEnabled: (settings[APP_SETTING_KEYS.META_ENABLED] ?? "true") === "true",
    whatsappPhoneNumberId: settings[APP_SETTING_KEYS.WHATSAPP_PHONE_NUMBER_ID] ?? env.whatsappPhoneNumberId,
    whatsappAccessToken: settings[APP_SETTING_KEYS.WHATSAPP_ACCESS_TOKEN] ?? env.whatsappAccessToken,
    whatsappBusinessAccountId:
      settings[APP_SETTING_KEYS.WHATSAPP_BUSINESS_ACCOUNT_ID] ?? env.whatsappBusinessAccountId,
    whatsappTemplateName: settings[APP_SETTING_KEYS.WHATSAPP_TEMPLATE_NAME] ?? env.whatsappTemplateName,
    whatsappTemplateLanguage:
      settings[APP_SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE] ?? env.whatsappTemplateLanguage ?? "id",
    whatsappGraphVersion: settings[APP_SETTING_KEYS.WHATSAPP_GRAPH_VERSION] ?? env.whatsappApiVersion ?? "v25.0",
    whatsappEnabled: (settings[APP_SETTING_KEYS.WHATSAPP_ENABLED] ?? "true") === "true",
  };
};

export const parseDatabaseName = (databaseUrl) => {
  try {
    if (!databaseUrl) return "";
    const url = new URL(databaseUrl);
    return url.pathname.replace(/^\//, "");
  } catch {
    return "";
  }
};
