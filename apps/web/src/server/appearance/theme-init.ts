import {
    FIXED_RETYPESET_THEME_ID,
    RETYPESET_THEME_ATTR,
    type RetypesetThemeId,
} from "@/lib/retypeset-themes"

export function resolveServerRetypesetTheme(): RetypesetThemeId {
    return FIXED_RETYPESET_THEME_ID
}

export function buildRetypesetThemeInitScript() {
    return `
(function () {
  document.documentElement.setAttribute(${JSON.stringify(RETYPESET_THEME_ATTR)}, ${JSON.stringify(FIXED_RETYPESET_THEME_ID)});
})();
`.trim()
}
