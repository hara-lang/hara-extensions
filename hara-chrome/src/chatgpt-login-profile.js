export const CHATGPT_LOGIN_PROFILE_PROTOCOL = "greenways.chatgpt-login-profile/0-alpha";

const freezeList = (values) => Object.freeze([...values]);

export const CHATGPT_LOGIN_PROFILE = Object.freeze({
  protocol: CHATGPT_LOGIN_PROFILE_PROTOCOL,
  id: "chatgpt-web-login/en/1",
  version: 1,
  locale: "en",
  chatgptOrigins: freezeList(["https://chatgpt.com"]),
  selectors: Object.freeze({
    loginTrigger: freezeList([
      '[data-hara-chatgpt-action="login"]',
      'a[href*="/auth/login"]',
      'button[data-testid="login-button"]',
      'button[aria-label*="Log in" i]',
      'a[aria-label*="Log in" i]',
      'button[aria-label*="Sign in" i]',
      'a[aria-label*="Sign in" i]',
    ]),
    authSurface: freezeList([
      '[data-hara-chatgpt-auth-state="credentials"]',
      'form[action*="/auth/"]',
      'input[type="email"]',
      'input[autocomplete="username"]',
      'input[type="password"]',
      '[role="dialog"][aria-label*="sign in" i]',
      '[role="dialog"][aria-label*="log in" i]',
    ]),
    verificationSurface: freezeList([
      '[data-hara-chatgpt-auth-state="verification"]',
      'input[autocomplete="one-time-code"]',
      'input[aria-label*="verification code" i]',
      'input[aria-label*="one-time code" i]',
      '[role="dialog"][aria-label*="verify" i]',
      '[aria-label*="passkey" i]',
    ]),
  }),
});

export function loginSelectorFor(profile, name) {
  const values = profile?.selectors?.[name];
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`ChatGPT login selector group is missing: ${name}`);
  }
  return values.join(", ");
}
