import type { ActionConfig, HomeAssistant, ThresholdConfig } from "./types";

export const fireEvent = <T>(node: HTMLElement | Window, type: string, detail?: T): void => {
  node.dispatchEvent(
    new CustomEvent(type, { detail, bubbles: true, composed: true }),
  );
};

/**
 * Colours arrive either as a theme token from the `ui_color` selector ("blue",
 * "primary", ...) or as raw CSS typed in YAML. Tokens map onto the theme's own
 * colour variables so light/dark mode keeps working.
 */
export const resolveColor = (color: string | undefined, fallback = "var(--primary-color)"): string => {
  if (!color) return fallback;
  const c = color.trim();
  if (!c || c === "none") return fallback;
  if (/^(#|rgb|hsl|var\(|color-mix\()/i.test(c)) return c;
  return `var(--${c}-color, ${fallback})`;
};

/** Highest threshold at or below the value wins; below every stop we fall back to bar_color. */
export const colorForValue = (
  value: number,
  thresholds: ThresholdConfig[] | undefined,
  barColor: string | undefined,
): string => {
  const fallback = resolveColor(barColor);
  if (!thresholds?.length) return fallback;
  const sorted = [...thresholds]
    .filter((t) => t && typeof t.value === "number" && !Number.isNaN(t.value))
    .sort((a, b) => a.value - b.value);
  let match: ThresholdConfig | undefined;
  for (const t of sorted) {
    if (value >= t.value) match = t;
  }
  return match ? resolveColor(match.color, fallback) : fallback;
};

const parseRgb = (value: string): [number, number, number] | undefined => {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export const luminance = (rgb: [number, number, number]): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

/**
 * Picks black or white content for whatever the bar actually renders as. The
 * colour may be a CSS variable, so it has to be read back off a live element
 * rather than parsed from the config.
 */
const INK_CROSSOVER = 0.179; // luminance where black and white score an equal WCAG ratio

export const contrastingInk = (computedBackground: string): "light" | "dark" => {
  const rgb = parseRgb(computedBackground);
  if (!rgb) return "light";
  return luminance(rgb) > INK_CROSSOVER ? "dark" : "light";
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const forwardHaptic = (node: HTMLElement, type: string) => fireEvent(node, "haptic", type);

export const handleAction = (
  node: HTMLElement,
  hass: HomeAssistant,
  config: {
    entity?: string;
    tap_action?: ActionConfig;
    hold_action?: ActionConfig;
    double_tap_action?: ActionConfig;
  },
  action: "tap" | "hold" | "double_tap",
): void => {
  let actionConfig: ActionConfig | undefined;
  if (action === "double_tap") actionConfig = config.double_tap_action;
  else if (action === "hold") actionConfig = config.hold_action;
  else actionConfig = config.tap_action;

  if (!actionConfig) {
    actionConfig = { action: action === "tap" ? "more-info" : "none" };
  }

  switch (actionConfig.action) {
    case "none":
      return;
    case "more-info":
      if (config.entity) {
        fireEvent(node, "hass-more-info", { entityId: config.entity });
      }
      break;
    case "navigate":
      if (actionConfig.navigation_path) {
        history.pushState(null, "", actionConfig.navigation_path);
        fireEvent(window, "location-changed", { replace: false });
      }
      break;
    case "url":
      if (actionConfig.url_path) {
        window.open(actionConfig.url_path, actionConfig.url_path.startsWith("/") ? "_self" : "_blank");
      }
      break;
    case "toggle":
      if (config.entity) {
        hass.callService("homeassistant", "toggle", { entity_id: config.entity });
        forwardHaptic(node, "light");
      }
      break;
    case "assist":
      fireEvent(node, "show-dialog", {
        dialogTag: "ha-voice-command-dialog",
        dialogImport: () => Promise.resolve(),
        dialogParams: {},
      });
      break;
    case "perform-action":
    case "call-service": {
      const actionName = actionConfig.perform_action ?? actionConfig.service;
      if (!actionName) return;
      const [domain, service] = actionName.split(".", 2);
      if (!domain || !service) return;
      hass.callService(domain, service, {
        ...(actionConfig.data ?? actionConfig.service_data ?? {}),
        ...(actionConfig.target ?? {}),
      });
      forwardHaptic(node, "light");
      break;
    }
    default:
      break;
  }
};
