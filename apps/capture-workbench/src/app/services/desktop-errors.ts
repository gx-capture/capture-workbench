// Formats and redacts desktop errors for display.
import { desktopMessages } from '../i18n/desktop-messages';

/** Converts unknown errors to redacted messages safe for host-facing UI. */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveMessage(message);
}

/**
 * Maps an uninstall rejection to settings copy.
 * The desktop bridge keeps only the HTTP status, so every 422 shares one message.
 */
export function uninstallFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const messages = desktopMessages();
  if (message.includes('HTTP 409')) return messages.removeRequirementInUse;
  if (message.includes('HTTP 422')) return messages.removeRequirementNotUninstallable;
  if (message.includes('HTTP 404')) return messages.removeRequirementNotFound;
  return errorMessage(error);
}

/** Removes bearer and token-shaped values from user-visible diagnostics. */
export function redactSensitiveMessage(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(
      /(?:authorization|bearerToken|access_token|token)\s*[:=]\s*["']?[^"'\s,;}]+/giu,
      (match) => `${match.slice(0, match.search(/[:=]/u) + 1)} [redacted]`,
    );
}
