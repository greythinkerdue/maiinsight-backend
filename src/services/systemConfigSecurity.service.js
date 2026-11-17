import { APP_SETTING_KEYS } from "./appConfig.service.js"

const hasText = (value) => Boolean(String(value || "").trim())

export const buildSafeIntegrationStatus = ({ config, aiProviderStatus }) => ({
  gemini: {
    configured: Boolean(config.geminiApiKey),
    enabled: config.geminiEnabled,
    connected: Boolean(aiProviderStatus.configured),
    provider: aiProviderStatus.provider,
    providerLabel: aiProviderStatus.providerLabel,
    model: aiProviderStatus.model,
  },
  meta: {
    configured: Boolean(config.metaAccessToken && config.metaIgUserId),
    enabled: config.metaEnabled,
    connected: Boolean(config.metaAccessToken && config.metaIgUserId) && config.metaEnabled,
    graphVersion: config.metaGraphVersion,
  },
  whatsapp: {
    configured: Boolean(
      config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappTemplateName
    ),
    enabled: config.whatsappEnabled,
    connected:
      Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId && config.whatsappTemplateName) &&
      config.whatsappEnabled,
    templateName: config.whatsappTemplateName,
    templateLanguage: config.whatsappTemplateLanguage,
    graphVersion: config.whatsappGraphVersion,
  },
})

export const buildSafeIntegrationConfig = (config) => ({
  geminiApiKey: config.geminiApiKey,
  geminiApiKeyConfigured: Boolean(config.geminiApiKey),
  geminiModel: config.geminiModel,
  geminiEnabled: config.geminiEnabled,
  metaAccessToken: config.metaAccessToken,
  metaAccessTokenConfigured: Boolean(config.metaAccessToken),
  metaIgUserId: config.metaIgUserId,
  metaGraphVersion: config.metaGraphVersion,
  metaEnabled: config.metaEnabled,
  whatsappAccessToken: config.whatsappAccessToken,
  whatsappAccessTokenConfigured: Boolean(config.whatsappAccessToken),
  whatsappPhoneNumberId: config.whatsappPhoneNumberId,
  whatsappBusinessAccountId: config.whatsappBusinessAccountId,
  whatsappTemplateName: config.whatsappTemplateName,
  whatsappTemplateLanguage: config.whatsappTemplateLanguage,
  whatsappGraphVersion: config.whatsappGraphVersion,
  whatsappEnabled: config.whatsappEnabled,
})

export const buildIntegrationSettingsUpdate = (input, currentConfig) => {
  const entries = {
    [APP_SETTING_KEYS.GEMINI_MODEL]:
      input.geminiModel ?? currentConfig.geminiModel,
    [APP_SETTING_KEYS.GEMINI_ENABLED]:
      input.geminiEnabled === true || input.geminiEnabled === "true"
        ? "true"
        : input.geminiEnabled === false || input.geminiEnabled === "false"
          ? "false"
          : currentConfig.geminiEnabled
            ? "true"
            : "false",
    [APP_SETTING_KEYS.META_IG_USER_ID]:
      input.metaIgUserId ?? currentConfig.metaIgUserId,
    [APP_SETTING_KEYS.META_GRAPH_VERSION]:
      input.metaGraphVersion ?? currentConfig.metaGraphVersion,
    [APP_SETTING_KEYS.META_ENABLED]:
      input.metaEnabled === true || input.metaEnabled === "true"
        ? "true"
        : input.metaEnabled === false || input.metaEnabled === "false"
          ? "false"
          : currentConfig.metaEnabled
            ? "true"
            : "false",
    [APP_SETTING_KEYS.WHATSAPP_PHONE_NUMBER_ID]:
      input.whatsappPhoneNumberId ?? currentConfig.whatsappPhoneNumberId,
    [APP_SETTING_KEYS.WHATSAPP_BUSINESS_ACCOUNT_ID]:
      input.whatsappBusinessAccountId ?? currentConfig.whatsappBusinessAccountId,
    [APP_SETTING_KEYS.WHATSAPP_TEMPLATE_NAME]:
      input.whatsappTemplateName ?? currentConfig.whatsappTemplateName,
    [APP_SETTING_KEYS.WHATSAPP_TEMPLATE_LANGUAGE]:
      input.whatsappTemplateLanguage ?? currentConfig.whatsappTemplateLanguage,
    [APP_SETTING_KEYS.WHATSAPP_GRAPH_VERSION]:
      input.whatsappGraphVersion ?? currentConfig.whatsappGraphVersion,
    [APP_SETTING_KEYS.WHATSAPP_ENABLED]:
      input.whatsappEnabled === true || input.whatsappEnabled === "true"
        ? "true"
        : input.whatsappEnabled === false || input.whatsappEnabled === "false"
          ? "false"
          : currentConfig.whatsappEnabled
            ? "true"
            : "false",
  }

  if (hasText(input.geminiApiKey)) {
    entries[APP_SETTING_KEYS.GEMINI_API_KEY] = String(input.geminiApiKey).trim()
  }
  if (hasText(input.metaAccessToken)) {
    entries[APP_SETTING_KEYS.META_ACCESS_TOKEN] = String(input.metaAccessToken).trim()
  }
  if (hasText(input.whatsappAccessToken)) {
    entries[APP_SETTING_KEYS.WHATSAPP_ACCESS_TOKEN] = String(input.whatsappAccessToken).trim()
  }
  return entries
}
