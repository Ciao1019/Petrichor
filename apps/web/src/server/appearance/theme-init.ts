import {
    RETYPESET_INITIAL_APPEARANCE_GLOBAL,
    RETYPESET_THEME_ATTR,
    RETYPESET_THEME_IDS,
    RETYPESET_THEME_STORAGE_AUTO,
    RETYPESET_THEME_STORAGE_KEY,
    normalizeAppearance,
    resolveRetypesetActiveTheme,
    type RetypesetAppearanceInput,
    type RetypesetThemeId,
} from "@/lib/retypeset-themes"

export function resolveServerRetypesetTheme(
    appearance: RetypesetAppearanceInput,
    now: Date = new Date(),
): RetypesetThemeId {
    const normalized = normalizeAppearance(appearance)
    return resolveRetypesetActiveTheme(normalized, now.getHours())
}

export function buildRetypesetThemeInitScript(appearance: RetypesetAppearanceInput) {
    const normalized = normalizeAppearance(appearance)
    const payload = {
        attr: RETYPESET_THEME_ATTR,
        globalName: RETYPESET_INITIAL_APPEARANCE_GLOBAL,
        storageKey: RETYPESET_THEME_STORAGE_KEY,
        storageAuto: RETYPESET_THEME_STORAGE_AUTO,
        themeIds: RETYPESET_THEME_IDS,
        appearance: normalized,
    }

    return `
(function () {
  var payload = ${toSafeInlineJson(payload)};
  var appearance = payload.appearance;
  var root = document.documentElement;

  function isThemeId(value) {
    return payload.themeIds.indexOf(value) !== -1;
  }

  function clampHour(value, fallback) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    var int = Math.trunc(n);
    if (int < 0) return 0;
    if (int > 24) return 24;
    return int;
  }

  function pickThemeByHour(hour) {
    var dayStartHour = clampHour(appearance.dayStartHour, 6);
    var dayEndHour = clampHour(appearance.dayEndHour, 18);
    if (dayStartHour === dayEndHour) return appearance.dayTheme;
    if (dayStartHour < dayEndHour) {
      return hour >= dayStartHour && hour < dayEndHour
        ? appearance.dayTheme
        : appearance.nightTheme;
    }
    return hour >= dayStartHour || hour < dayEndHour
      ? appearance.dayTheme
      : appearance.nightTheme;
  }

  function readOverride() {
    if (!appearance.allowManualOverride) return null;
    try {
      var raw = window.localStorage.getItem(payload.storageKey);
      if (!raw || raw === payload.storageAuto) return null;
      return isThemeId(raw) ? raw : null;
    } catch (error) {
      return null;
    }
  }

  window[payload.globalName] = appearance;
  root.setAttribute(payload.attr, readOverride() || pickThemeByHour(new Date().getHours()));
})();
`.trim()
}

function toSafeInlineJson(value: unknown) {
    return JSON.stringify(value).replace(/</g, "\\u003c")
}
