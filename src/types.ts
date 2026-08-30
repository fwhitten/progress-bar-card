export interface HassEntityAttributes {
  friendly_name?: string;
  unit_of_measurement?: string;
  icon?: string;
  [key: string]: unknown;
}

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: HassEntityAttributes;
  last_changed: string;
  last_updated: string;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  themes: { darkMode?: boolean; [key: string]: unknown };
  locale: unknown;
  callService(domain: string, service: string, data?: Record<string, unknown>): Promise<unknown>;
  formatEntityState?(stateObj: HassEntity, state?: string): string;
  formatEntityAttributeValue?(stateObj: HassEntity, attribute: string, value?: unknown): string;
  localize(key: string, ...args: unknown[]): string;
  [key: string]: unknown;
}

export interface ActionConfig {
  action: string;
  navigation_path?: string;
  url_path?: string;
  service?: string;
  perform_action?: string;
  target?: Record<string, unknown>;
  data?: Record<string, unknown>;
  service_data?: Record<string, unknown>;
  confirmation?: unknown;
  [key: string]: unknown;
}

/** A single colour stop. The bar takes the colour of the highest stop the value has reached. */
export interface ThresholdConfig {
  value: number;
  color: string;
}

export type ValueMode = "auto" | "percentage" | "value";
export type CardShape = "theme" | "rounded";

export interface ProgressCardConfig {
  type: string;
  entity: string;
  attribute?: string;
  name?: string;
  icon?: string;
  min?: number;
  max?: number;
  show_value?: boolean;
  value_mode?: ValueMode;
  shape?: CardShape;
  bar_color?: string;
  thresholds?: ThresholdConfig[];
  secondary_entities?: string[];
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: ProgressCardConfig): void;
}
