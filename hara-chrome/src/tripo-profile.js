export const TRIPO_PROFILE_PROTOCOL = "greenways.tripo-selector-profile/0-alpha";

const freezeList = (values) => Object.freeze([...values]);

export const TRIPO_SELECTOR_PROFILE = Object.freeze({
  protocol: TRIPO_PROFILE_PROTOCOL,
  id: "tripo-studio/en/1",
  version: 1,
  locale: "en",
  origins: freezeList(["https://studio.tripo3d.ai"]),
  selectors: Object.freeze({
    navigation: freezeList([
      '[data-hara-tripo-navigation="true"]',
      'nav[aria-label*="Studio" i]',
      'nav[aria-label*="Tripo" i]',
      'nav',
      '[role="navigation"]',
    ]),
    signedIn: freezeList([
      '[data-hara-tripo-signed-in="true"]',
      'button[data-testid*="avatar" i]',
      'button[data-testid*="account" i]',
      'button[data-testid*="user-menu" i]',
      'button[aria-label*="Account" i]',
      'button[aria-label*="Profile" i]',
    ]),
    signedOut: freezeList([
      '[data-hara-tripo-signed-in="false"]',
      '[data-hara-tripo-action="login"]',
      'a[href*="/login" i]',
      'a[href*="/signin" i]',
      'button[data-testid*="login" i]',
      'button[aria-label*="Log in" i]',
      'button[aria-label*="Sign in" i]',
      'button[aria-label*="Sign up" i]',
    ]),
    loginTrigger: freezeList([
      '[data-hara-tripo-action="login"]',
      'a[href*="/login" i]',
      'a[href*="/signin" i]',
      'button[data-testid*="login" i]',
      'button[aria-label*="Sign up/Log in" i]',
      'button[aria-label*="Log in" i]',
      'button[aria-label*="Sign in" i]',
      'a[aria-label*="Log in" i]',
      'a[aria-label*="Sign in" i]',
    ]),
    authSurface: freezeList([
      '[data-hara-tripo-auth-state="credentials"]',
      'form[action*="/auth/" i]',
      'form[action*="/login" i]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[type="password"]',
    ]),
    verificationSurface: freezeList([
      '[data-hara-tripo-auth-state="verification"]',
      'input[autocomplete="one-time-code"]',
      'input[aria-label*="verification code" i]',
      'input[aria-label*="security code" i]',
      '[aria-label*="passkey" i]',
    ]),
    workspace: freezeList([
      '[data-hara-tripo-workspace-current="true"]',
      '[data-testid*="workspace-switcher" i]',
      'button[data-testid*="workspace" i]',
      'button[aria-label*="Workspace" i]',
      '[role="button"][aria-label*="Workspace" i]',
    ]),
    assetsNav: freezeList([
      '[data-hara-tripo-action="assets"]',
      'a[href*="/assets" i]',
      'a[aria-label="Assets" i]',
      '[role="link"][aria-label="Assets" i]',
    ]),
    assetLibrary: freezeList([
      '[data-hara-tripo-surface="assets"]',
      '[data-testid*="asset-library" i]',
      'main[aria-label*="Assets" i]',
      'main[data-testid*="assets" i]',
    ]),
    assets: freezeList([
      'a[data-hara-tripo-kind="asset"][href]',
      '[data-testid*="asset-card" i] a[href]',
      '[data-testid*="model-card" i] a[href]',
      'main a[href*="/asset/" i]',
      'main a[href*="/assets/" i]',
      'main a[href*="/model/" i]',
      'main a[href*="/task/" i]',
    ]),
    assetDetail: freezeList([
      '[data-hara-tripo-surface="asset-detail"]',
      'main[data-asset-id]',
      'main[data-model-id]',
      'main[aria-label*="Model" i]',
      'main[aria-label*="Asset" i]',
    ]),
    exportTrigger: freezeList([
      '[data-hara-tripo-action="export"]',
      'button[data-testid*="export" i]',
      'button[aria-label="Export" i]',
      '[role="button"][aria-label="Export" i]',
    ]),
    exportSurface: freezeList([
      '[data-hara-tripo-surface="export"]',
      '[role="dialog"][aria-label*="Export" i]',
      '[role="dialog"][aria-label*="Download" i]',
      '[data-testid*="export-dialog" i]',
    ]),
    exportFormats: freezeList([
      '[data-hara-tripo-export-format]',
      '[role="dialog"] [data-export-format]',
      '[role="dialog"] [role="radio"][aria-label]',
      '[role="dialog"] button[data-format]',
    ]),
    exportConfirm: freezeList([
      '[data-hara-tripo-action="download"]',
      '[role="dialog"] button[data-testid*="download" i]',
      '[role="dialog"] button[aria-label="Download" i]',
      '[role="dialog"] [role="button"][aria-label="Download" i]',
    ]),
    exportBlocked: freezeList([
      '[data-hara-tripo-export-blocked="true"]',
      '[role="dialog"] [data-export-unavailable="true"]',
      '[role="dialog"] [role="alert"]',
      '[role="dialog"] [aria-label*="Upgrade" i]',
      '[role="dialog"] [aria-label*="limit" i]',
    ]),
  }),
});

export function selectorFor(profile, name) {
  const values = profile?.selectors?.[name];
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`Tripo selector group is missing: ${name}`);
  }
  return values.join(", ");
}
