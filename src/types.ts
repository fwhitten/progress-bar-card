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
  callService(
    domain: string,
    service: string,
    data?: Record<string, unknown>,
    target?: Record<string, unknown>,
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<unknown>;
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

/** One entry of a calendar.get_events response. Note there is no uid. */
export interface RawCalendarEvent {
  start?: string;
  end?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
}

export interface CalendarEvent {
  /** Synthesised, since the list response carries no uid. */
  key: string;
  summary: string;
  location?: string;
  /** Epoch milliseconds. All-day events span local midnight to local midnight. */
  start: number;
  end: number;
  allDay: boolean;
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
  /** While `pin_entity` sits in one of `pin_states`, the bar is forced to `pin_value`. */
  pin_entity?: string;
  pin_states?: string[];
  pin_value?: "max" | "min" | number | string;
  /** Replaces the right-hand value with another entity's formatted state. */
  value_entity?: string;
  /** Break the right-hand value at spaces, one centred line per word. */
  value_wrap?: boolean;
  /** Calendar only: when the card should remove itself from the view. */
  hide_when?: "never" | "no_events_today" | "no_events";
  include_all_day?: boolean;
  cycle_interval?: number;
  look_ahead_days?: number;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
}

export interface LovelaceCardEditor extends HTMLElement {
  hass?: HomeAssistant;
  setConfig(config: ProgressCardConfig): void;
}
