import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { CARD_NAME, CARD_VERSION, EDITOR_NAME } from "./const";
import type { CalendarEvent, HassEntity, HomeAssistant, ProgressCardConfig } from "./types";
import {
  eventFromAttributes,
  eventsInProgress,
  fetchCalendarEvents,
  FRESH_MAX_AGE,
  formatDuration,
  invalidateCalendar,
  nextEventAfter,
  parseEvents,
  tickInterval,
} from "./calendar";
import { clamp, colorForValue, contrastingInk, fireEvent, handleAction } from "./utils";

/* eslint-disable no-console */
console.info(
  `%c HA-PROGRESS-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#3f8fd6;font-weight:700;border-radius:4px 0 0 4px;padding:2px 4px",
  "color:#3f8fd6;background:#2b2b2b;border-radius:0 4px 4px 0;padding:2px 4px",
);

const BASE_ROW_HEIGHT = 56;
/** From about three rows up, the fill rises from the bottom behind a giant value. */
const TALL_FILL_HEIGHT = 150;
/** From four rows up, the ring stands on its own above the text. */
const TALL_RING_HEIGHT = 220;
/** Below this the dots sit inline beside the text instead of filling the card. */
const COMPACT_HEIGHT = 90;
const DOT_CELL = 26;
const UNAVAILABLE_STATES = new Set(["unavailable", "unknown", "none", ""]);

/**
 * The editor's expandable sections were missing ha-form's `flatten`, so it
 * saved their fields nested under the section name instead of at the top
 * level. Hoist those back out so configs written by older versions still work.
 */
const NESTED_SECTIONS = ["interactions", "pin"] as const;

const hoistSections = (config: ProgressCardConfig): ProgressCardConfig => {
  let result = config as ProgressCardConfig & Record<string, unknown>;
  for (const section of NESTED_SECTIONS) {
    const nested = result[section];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    result = { ...result, ...(nested as Partial<ProgressCardConfig>) };
    delete result[section];
  }
  return result;
};

const CALENDAR_DOMAIN = "calendar.";
const DEFAULT_CYCLE_SECONDS = 6;
const DEFAULT_LOOK_AHEAD_DAYS = 7;
const CALENDAR_REFRESH_MS = 5 * 60 * 1000;
const FADE_MS = 300;

/** Everything the two content layers need, whichever mode produced it. */
interface ViewModel {
  available: boolean;
  percentage: number;
  /** The number thresholds are compared against. */
  thresholdValue: number;
  name: string;
  secondary: string;
  valueText: string;
  showValue: boolean;
}

/** Whether a line overflows, and how far the loop travels before it repeats. */
interface LineMetrics {
  scroll: boolean;
  dist: number;
}

const EMPTY_METRICS: LineMetrics = { scroll: false, dist: 0 };

@customElement(CARD_NAME)
export class HaProgressCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @property({ type: Boolean }) public preview = false;
  @property({ type: Boolean }) public editMode = false;

  /**
   * Without this, hui-card detaches the element while it is hidden, which would
   * stop the clock that decides when to show it again.
   */
  public connectedWhileHidden = true;

  @state() private _config?: ProgressCardConfig;
  @state() private _scale = 1;
  @state() private _size = { w: 0, h: 0 };
  @state() private _name: LineMetrics = EMPTY_METRICS;
  @state() private _secondary: LineMetrics = EMPTY_METRICS;
  @state() private _ink: "light" | "dark" = "light";
  @state() private _events: CalendarEvent[] = [];
  @state() private _cycleIndex = 0;
  @state() private _fade = false;
  @state() private _now = Date.now();
  @state() private _eventsLoaded = false;

  private _resizeObserver?: ResizeObserver;
  private _tickTimer?: number;
  private _cycleTimer?: number;
  private _refreshTimer?: number;
  private _calendarStamp?: string;
  private _fadeTimer?: number;
  private _runningSignature = "";
  private _docVisible = !document.hidden;
  private _onScreen = true;
  private _intersectionObserver?: IntersectionObserver;
  private _holdTimer?: number;
  private _tapTimer?: number;
  private _held = false;

  public static async getConfigElement(): Promise<HTMLElement> {
    await import("./editor");
    return document.createElement(EDITOR_NAME);
  }

  public static getStubConfig(hass?: HomeAssistant): Partial<ProgressCardConfig> {
    const entity = hass
      ? Object.keys(hass.states).find(
          (id) =>
            id.startsWith("sensor.") &&
            hass.states[id].attributes.unit_of_measurement === "%" &&
            !Number.isNaN(Number(hass.states[id].state)),
        ) ?? Object.keys(hass.states).find((id) => id.startsWith("sensor."))
      : undefined;
    return {
      entity: entity ?? "",
      min: 0,
      max: 100,
      show_value: true,
      value_mode: "auto",
      shape: "rounded",
      design: "fill",
    };
  }

  public setConfig(config: ProgressCardConfig): void {
    if (!config?.entity) {
      throw new Error("You need to define an entity");
    }
    this._config = {
      min: 0,
      max: 100,
      show_value: true,
      value_mode: "auto",
      shape: "rounded",
      design: "fill",
      ...hoistSections(config),
    };

    // Window and filtering are config-dependent, so start the calendar over.
    if (this._isCalendar) {
      invalidateCalendar(this._config.entity);
      this._calendarStamp = undefined;
      this._events = [];
      this._cycleIndex = 0;
      this._runningSignature = "";
    }
  }

  public getCardSize(): number {
    return 1;
  }

  /** Sections view: one row tall by default, never taller than four. */
  public getGridOptions(): Record<string, number> {
    return {
      rows: 1,
      min_rows: 1,
      max_rows: 4,
      columns: 12,
      min_columns: 6,
    };
  }

  public override connectedCallback(): void {
    super.connectedCallback();
    this._resizeObserver ??= new ResizeObserver(() => this._measure());
    if (this.shadowRoot?.firstElementChild) {
      this._resizeObserver.observe(this);
    }

    this._docVisible = !document.hidden;
    document.addEventListener("visibilitychange", this._onVisibilityChange);
    this._intersectionObserver ??= new IntersectionObserver((entries) => {
      const onScreen = entries.some((entry) => entry.isIntersecting);
      if (onScreen === this._onScreen) return;
      this._onScreen = onScreen;
      this._wake();
    });
    this._intersectionObserver.observe(this);
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this._clearTimers();
    this._stopCalendar();
  }

  private get _stateObj(): HassEntity | undefined {
    if (!this.hass || !this._config?.entity) return undefined;
    return this.hass.states[this._config.entity];
  }

  private _rawValue(stateObj: HassEntity): unknown {
    return this._config?.attribute ? stateObj.attributes[this._config.attribute] : stateObj.state;
  }

  private _unit(stateObj: HassEntity): string | undefined {
    if (this._config?.attribute) return undefined;
    return stateObj.attributes.unit_of_measurement;
  }

  private _formatValue(
    stateObj: HassEntity,
    numeric: number,
    percentage: number,
    pinned: boolean,
  ): string {
    const config = this._config!;
    const unit = this._unit(stateObj);
    const mode = config.value_mode ?? "auto";
    const usePercentage =
      mode === "percentage" || (mode === "auto" && (unit === "%" || unit === undefined));

    if (usePercentage) {
      return `${Math.round(percentage)}%`;
    }

    // The entity still reports its own (meaningless) value while pinned.
    if (pinned) {
      return unit ? `${numeric} ${unit}` : `${numeric}`;
    }

    if (config.attribute) {
      const formatted = this.hass?.formatEntityAttributeValue?.(stateObj, config.attribute);
      if (formatted) return formatted;
      return unit ? `${numeric} ${unit}` : `${numeric}`;
    }

    const formatted = this.hass?.formatEntityState?.(stateObj);
    if (formatted) return formatted;
    return unit ? `${numeric} ${unit}` : `${numeric}`;
  }

  private _customValueText(): string | undefined {
    const entityId = this._config?.value_entity;
    if (!entityId || !this.hass) return undefined;
    const stateObj = this.hass.states[entityId];
    if (!stateObj) return undefined;
    return this.hass.formatEntityState?.(stateObj) ?? stateObj.state;
  }

  private _secondaryText(): string {
    const entities = this._config?.secondary_entities?.slice(0, 2) ?? [];
    if (!entities.length || !this.hass) return "";
    return entities
      .map((entityId) => {
        const stateObj = this.hass!.states[entityId];
        if (!stateObj) return undefined;
        return this.hass!.formatEntityState?.(stateObj) ?? stateObj.state;
      })
      .filter((text): text is string => Boolean(text))
      .join(" • ");
  }

  private get _isCalendar(): boolean {
    return Boolean(this._config?.entity?.startsWith(CALENDAR_DOMAIN));
  }

  private get _calendarOptions() {
    return {
      includeAllDay: this._config?.include_all_day !== false,
      lookAhead: Math.max(1, Number(this._config?.look_ahead_days ?? DEFAULT_LOOK_AHEAD_DAYS)),
      cycleMs:
        Math.max(1, Number(this._config?.cycle_interval ?? DEFAULT_CYCLE_SECONDS)) * 1000,
    };
  }

  /** Ticking and cycling stop while the card is off-screen or the tab is hidden. */
  private get _awake(): boolean {
    return this._docVisible && this._onScreen;
  }

  /**
   * Appliances commonly reset their progress sensor to 0 the moment a cycle
   * ends, so a linked entity can pin the bar while it reports a finished state.
   * Checked ahead of availability: the progress entity often goes unavailable
   * at exactly the same moment.
   */
  private _pinnedValue(): number | undefined {
    const config = this._config;
    if (!config?.pin_states?.length || !this.hass) return undefined;

    const stateObj = this.hass.states[config.pin_entity ?? config.entity];
    if (!stateObj) return undefined;

    // Home Assistant translates states for display, so match the raw value.
    const current = stateObj.state?.toLowerCase();
    const matched = config.pin_states.some((state) => String(state).toLowerCase() === current);
    if (!matched) return undefined;

    const min = Number(config.min ?? 0);
    const max = Number(config.max ?? 100);
    const pin = config.pin_value ?? "max";
    if (pin === "max") return max;
    if (pin === "min") return min;

    const numeric = Number(pin);
    return Number.isNaN(numeric) ? max : numeric;
  }

  private _numericView(stateObj: HassEntity): ViewModel {
    const config = this._config!;
    const pinned = this._pinnedValue();
    const numeric = pinned ?? Number(this._rawValue(stateObj));
    const available =
      pinned !== undefined ||
      (!UNAVAILABLE_STATES.has(stateObj.state) && !Number.isNaN(numeric));

    const min = Number(config.min ?? 0);
    const max = Number(config.max ?? 100);
    const span = max - min;
    const percentage = available && span !== 0 ? clamp(((numeric - min) / span) * 100, 0, 100) : 0;

    return {
      available,
      percentage,
      thresholdValue: numeric,
      name: config.name ?? stateObj.attributes.friendly_name ?? stateObj.entity_id,
      secondary: this._secondaryText(),
      valueText:
        this._customValueText() ??
        (available
          ? this._formatValue(stateObj, numeric, percentage, pinned !== undefined)
          : ""),
      showValue: config.show_value !== false && available,
    };
  }

  /**
   * A running event drives the bar; with nothing running the bar sits empty and
   * the secondary line counts down to the next event's start.
   */
  private _calendarView(stateObj: HassEntity): ViewModel {
    const config = this._config!;
    const now = this._now;
    const running = eventsInProgress(this._events, now);
    const event = running.length
      ? running[this._cycleIndex % running.length]
      : nextEventAfter(this._events, now);
    const extras = this._secondaryText();

    if (!event) {
      return {
        available: false,
        percentage: 0,
        thresholdValue: 0,
        name: config.name ?? stateObj.attributes.friendly_name ?? stateObj.entity_id,
        secondary: extras || "No upcoming events",
        valueText: "",
        showValue: false,
      };
    }

    const active = event.start <= now && now < event.end;
    const span = event.end - event.start;
    const percentage = active && span > 0 ? clamp(((now - event.start) / span) * 100, 0, 100) : 0;
    const countdown = active
      ? formatDuration(event.end - now)
      : `in ${formatDuration(event.start - now)}`;

    return {
      available: true,
      percentage,
      thresholdValue: percentage,
      name: config.name ?? event.summary,
      secondary: [countdown, extras].filter(Boolean).join(" • "),
      valueText: this._customValueText() ?? `${Math.round(percentage)}%`,
      showValue: config.show_value !== false,
    };
  }

  private async _loadEvents(fresh: boolean): Promise<void> {
    const entity = this._config?.entity;
    if (!this.hass || !entity || !this._isCalendar) return;

    const { includeAllDay, lookAhead } = this._calendarOptions;
    try {
      const raw = await fetchCalendarEvents(
        this.hass,
        entity,
        lookAhead,
        fresh ? FRESH_MAX_AGE : undefined,
      );
      this._events = parseEvents(raw, includeAllDay);
    } catch (_err) {
      // get_events may be unavailable. The entity still exposes one event.
      const fallback = eventFromAttributes(this._stateObj?.attributes ?? {}, includeAllDay);
      this._events = fallback ? [fallback] : [];
    }

    this._eventsLoaded = true;
    this._now = Date.now();
    this._runningSignature = "";
    this._syncCycle();
    this._scheduleTick();
  }

  /**
   * "Today" means anything overlapping now through midnight, so an event
   * already running (including a multi-day one) still counts.
   */
  private _shouldHide(): boolean {
    const mode = this._config?.hide_when ?? "never";
    if (mode === "never" || !this._isCalendar) return false;
    // Staying visible in the editor keeps the card configurable when empty.
    if (this.preview || this.editMode) return false;
    // Avoid flashing hidden before the first fetch has resolved.
    if (!this._eventsLoaded) return false;

    if (mode === "no_events") return this._events.length === 0;

    const endOfToday = new Date(this._now);
    endOfToday.setHours(23, 59, 59, 999);
    const limit = endOfToday.getTime();
    return !this._events.some((event) => event.start <= limit && event.end > this._now);
  }

  private _syncVisibility(): void {
    const hide = this._shouldHide();
    if (this.hidden === hide) return;
    this.hidden = hide;
    fireEvent(this, "card-visibility-changed", { value: !hide });
  }

  private _syncCalendar(): void {
    if (!this._isCalendar) {
      this._stopCalendar();
      return;
    }
    if (!this.hass) return;

    const stamp = this._stateObj?.last_updated;
    if (stamp !== this._calendarStamp) {
      this._calendarStamp = stamp;
      void this._loadEvents(true);
    }
    if (!this._refreshTimer) {
      this._refreshTimer = window.setInterval(
        () => void this._loadEvents(true),
        CALENDAR_REFRESH_MS,
      );
    }
    if (!this._tickTimer) this._scheduleTick();
  }

  private _scheduleTick(): void {
    if (this._tickTimer) window.clearTimeout(this._tickTimer);
    this._tickTimer = undefined;
    if (!this._isCalendar || !this._awake) return;

    const now = Date.now();
    const running = eventsInProgress(this._events, now);
    const next = nextEventAfter(this._events, now);
    const boundary = running.length
      ? Math.min(...running.map((event) => event.end))
      : next?.start;

    this._tickTimer = window.setTimeout(
      () => {
        this._now = Date.now();
        this._syncCycle();
        this._scheduleTick();
      },
      tickInterval(boundary === undefined ? Number.POSITIVE_INFINITY : boundary - now),
    );
  }

  /** Only restarts the cycle when the set of running events actually changes. */
  private _syncCycle(): void {
    const running = eventsInProgress(this._events, Date.now());
    const signature = running.map((event) => event.key).join("|");
    if (signature === this._runningSignature) return;

    this._runningSignature = signature;
    this._cycleIndex = 0;
    this._fade = false;
    this._scheduleCycle(running.length);
  }

  private _scheduleCycle(count: number): void {
    if (this._cycleTimer) window.clearInterval(this._cycleTimer);
    this._cycleTimer = undefined;
    if (count < 2 || !this._awake) return;

    this._cycleTimer = window.setInterval(() => {
      this._fade = true;
      if (this._fadeTimer) window.clearTimeout(this._fadeTimer);
      this._fadeTimer = window.setTimeout(() => {
        this._cycleIndex = (this._cycleIndex + 1) % count;
        this._fade = false;
      }, FADE_MS);
    }, this._calendarOptions.cycleMs);
  }

  private _stopCalendar(): void {
    [this._tickTimer, this._fadeTimer].forEach((id) => id && window.clearTimeout(id));
    [this._cycleTimer, this._refreshTimer].forEach((id) => id && window.clearInterval(id));
    this._tickTimer = undefined;
    this._fadeTimer = undefined;
    this._cycleTimer = undefined;
    this._refreshTimer = undefined;
  }

  private _onVisibilityChange = (): void => {
    this._docVisible = !document.hidden;
    this._wake();
  };

  private _wake(): void {
    if (!this._isCalendar) return;
    this._now = Date.now();
    this._runningSignature = "";
    this._syncCycle();
    this._scheduleTick();
  }

  protected override render(): TemplateResult | typeof nothing {
    if (!this._config || !this.hass) return nothing;

    const stateObj = this._stateObj;
    const { w: width, h: height } = this._size;
    const radius =
      this._config.shape === "theme"
        ? "var(--ha-card-border-radius, 12px)"
        : height > 72
          ? "28px"
          : "999px";

    if (!stateObj) {
      return html`
        <ha-card style=${styleMap({ "--pb-radius": radius })} class="unavailable">
          <div class="layer base">
            <div class="content">
              <ha-icon class="icon" icon="mdi:alert-circle-outline"></ha-icon>
              <div class="text">
                <div class="line name"><span>${this._config.entity}</span></div>
                <div class="line secondary"><span>Entity not found</span></div>
              </div>
            </div>
          </div>
        </ha-card>
      `;
    }

    const view = this._isCalendar ? this._calendarView(stateObj) : this._numericView(stateObj);
    const { available, percentage, name, secondary: secondaryText, valueText, showValue } = view;

    const barColor = colorForValue(
      view.thresholdValue,
      this._config.thresholds,
      this._config.bar_color,
    );

    const design = this._config.design ?? "fill";
    const tall = design === "fill" && height >= TALL_FILL_HEIGHT;
    const shown = available ? percentage : 0;

    const hostStyle = styleMap({
      "--pb-radius": radius,
      "--pb-scale": String(design === "fill" && !tall ? this._scale : 1),
      "--pb-card-h": `${height}px`,
      "--pb-bar-color": barColor,
      "--pb-ink-primary": this._ink === "dark" ? "rgba(0, 0, 0, 0.92)" : "rgba(255, 255, 255, 0.98)",
      "--pb-ink-secondary": this._ink === "dark" ? "rgba(0, 0, 0, 0.66)" : "rgba(255, 255, 255, 0.78)",
    });
    const fillStyle = styleMap(tall ? { height: `${shown}%` } : { width: `${shown}%` });

    let body: TemplateResult;
    if (design === "ring") {
      body = html`<div class="layer base">
        ${this._renderRing(stateObj, shown, name, secondaryText, valueText, showValue, width, height)}
      </div>`;
    } else if (design === "dots") {
      body = html`<div class="layer base">
        ${this._renderDots(stateObj, shown, name, secondaryText, valueText, showValue, width, height)}
      </div>`;
    } else {
      body = html`
        <div class="fill" style=${fillStyle}></div>
        <div class="layer base">
          ${this._renderContent(stateObj, name, secondaryText, valueText, showValue, tall)}
        </div>
        <div class="clip" style=${fillStyle}>
          ${this._renderContent(stateObj, name, secondaryText, valueText, showValue, tall)}
        </div>
      `;
    }

    return html`
      <ha-card
        style=${hostStyle}
        class=${classMap({
          unavailable: !available,
          interactive: this._hasAction(),
          tall,
          [`design-${design}`]: true,
        })}
        role=${this._hasAction() ? "button" : "presentation"}
        tabindex=${this._hasAction() ? "0" : "-1"}
        @pointerdown=${this._onPointerDown}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerCancel}
        @pointerleave=${this._onPointerCancel}
        @keydown=${this._onKeyDown}
      >
        ${body}
      </ha-card>
    `;
  }

  private _renderIcon(stateObj: HassEntity): TemplateResult {
    const icon = this._config?.icon;
    return icon
      ? html`<ha-icon class="icon" .icon=${icon}></ha-icon>`
      : html`<ha-state-icon class="icon" .hass=${this.hass} .stateObj=${stateObj}></ha-state-icon>`;
  }

  private _renderText(name: string, secondary: string): TemplateResult {
    return html`<div class="text">
      ${this._renderLine("name", name, this._name)}
      ${secondary ? this._renderLine("secondary", secondary, this._secondary) : nothing}
    </div>`;
  }

  /** A ring that fills clockwise. `pathLength` lets the dash maths stay in percent. */
  private _ringSvg(percentage: number): TemplateResult {
    return html`<svg class="ring-svg" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring-track" cx="50" cy="50" r="44" pathLength="100"></circle>
      <circle
        class="ring-bar"
        cx="50"
        cy="50"
        r="44"
        pathLength="100"
        stroke-dasharray="100"
        stroke-dashoffset=${100 - percentage}
        opacity=${percentage > 0 ? 1 : 0}
      ></circle>
    </svg>`;
  }

  private _renderRing(
    stateObj: HassEntity,
    percentage: number,
    name: string,
    secondary: string,
    valueText: string,
    showValue: boolean,
    width: number,
    height: number,
  ): TemplateResult {
    const stacked = height >= TALL_RING_HEIGHT;
    const compact = height < COMPACT_HEIGHT;
    const size = stacked
      ? clamp(height - 96, 80, Math.min(width - 32, 200))
      : compact
        ? Math.max(32, height - 16)
        : Math.min(height - 28, 130);

    // One row: icon in the ring, value to the right. Taller: value in the ring.
    const centre = compact
      ? this._renderIcon(stateObj)
      : html`${size >= 96 || stacked ? this._renderIcon(stateObj) : nothing}
        ${showValue
          ? html`<div class="ring-value" style=${styleMap({ fontSize: `${size * 0.22}px` })}>
              ${valueText}
            </div>`
          : nothing}`;

    return html`
      <div class=${classMap({ content: true, ring: true, stacked, fade: this._fade })}>
        <div class="ring-box" style=${styleMap({ width: `${size}px`, height: `${size}px` })}>
          ${this._ringSvg(percentage)}
          <div class="ring-centre">${centre}</div>
        </div>
        ${this._renderText(name, secondary)}
        ${compact && showValue ? this._renderValue(valueText) : nothing}
      </div>
    `;
  }

  private _renderDots(
    stateObj: HassEntity,
    percentage: number,
    name: string,
    secondary: string,
    valueText: string,
    showValue: boolean,
    width: number,
    height: number,
  ): TemplateResult {
    const compact = height < COMPACT_HEIGHT;
    const cols = compact ? 10 : Math.max(4, Math.floor((width - 16) / DOT_CELL));
    const rows = compact ? 2 : Math.max(1, Math.floor((height - BASE_ROW_HEIGHT - 8) / DOT_CELL));
    const total = cols * rows;
    const lit = (percentage / 100) * total;
    const whole = Math.floor(lit);

    const dots = Array.from({ length: total }, (_, index) =>
      html`<span
        class=${classMap({ dot: true, on: index < whole, part: index === whole && lit > whole })}
      ></span>`,
    );
    const grid = html`<div
      class=${classMap({ dots: true, inline: compact })}
      style=${styleMap({
        "grid-template-columns": `repeat(${cols}, 1fr)`,
        "--pb-dot": compact ? "6px" : `${Math.round(DOT_CELL * 0.7)}px`,
      })}
    >
      ${dots}
    </div>`;

    return html`
      <div class=${classMap({ content: true, "dots-layout": !compact, fade: this._fade })}>
        <div class="dots-head">
          ${this._renderIcon(stateObj)} ${this._renderText(name, secondary)}
          ${compact ? grid : nothing} ${showValue ? this._renderValue(valueText) : nothing}
        </div>
        ${compact ? nothing : grid}
      </div>
    `;
  }

  /**
   * Rendered twice: once against the card background and once inside the bar's
   * clipping box. Keeping both copies identical is what lets a glyph sitting on
   * the fill edge be half one colour and half the other.
   */
  private _renderContent(
    stateObj: HassEntity,
    name: string,
    secondary: string,
    valueText: string,
    showValue: boolean,
    tall = false,
  ): TemplateResult {
    if (tall) {
      // The value becomes a giant ghost numeral that the rising fill reveals.
      const { w, h } = this._size;
      const ghost = clamp(
        Math.min(h * 0.62, (w * 0.9) / Math.max(1, valueText.length * 0.55)),
        28,
        200,
      );
      return html`
        <div class=${classMap({ content: true, tall: true, fade: this._fade })}>
          ${showValue
            ? html`<div class="ghost" style=${styleMap({ fontSize: `${ghost}px` })}>${valueText}</div>`
            : nothing}
          <div class="head">${this._renderIcon(stateObj)} ${this._renderText(name, secondary)}</div>
        </div>
      `;
    }
    return html`
      <div class=${classMap({ content: true, fade: this._fade })}>
        ${this._renderIcon(stateObj)} ${this._renderText(name, secondary)}
        ${showValue ? this._renderValue(valueText) : nothing}
      </div>
    `;
  }

  /**
   * An overflowing line is rendered twice, each copy followed by a separator,
   * and translated by exactly one copy's width. The second copy lands where the
   * first began, so the loop is seamless rather than bouncing back.
   */
  private _renderLine(kind: "name" | "secondary", text: string, metrics: LineMetrics): TemplateResult {
    const animating = metrics.scroll && metrics.dist > 0;
    const chunk = html`<span class="chunk"
      ><span class="txt">${text}</span>${metrics.scroll
        ? html`<span class="sep">|</span>`
        : nothing}</span
    >`;
    return html`
      <div
        class=${classMap({ line: true, [kind]: true, scroll: metrics.scroll, animating })}
        style=${styleMap({
          "--pb-dist": `${metrics.dist}px`,
          "--pb-dur": `${this._duration(metrics.dist)}s`,
        })}
      >
        <span class="track">${chunk}${metrics.scroll ? chunk : nothing}</span>
      </div>
    `;
  }

  private _renderValue(valueText: string): TemplateResult {
    if (!this._config?.value_wrap) {
      return html`<div class="value">${valueText}</div>`;
    }
    const parts = valueText.split(/\s+/).filter(Boolean);
    return html`<div class="value wrap">
      ${parts.map((part) => html`<span>${part}</span>`)}
    </div>`;
  }

  private _duration(distance: number): number {
    return Math.max(4, Math.round(distance / 30));
  }

  protected override firstUpdated(): void {
    this._resizeObserver ??= new ResizeObserver(() => this._measure());
    this._resizeObserver.observe(this);
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    this._measure();
    this._syncInk();
    this._syncCalendar();
    this._syncVisibility();
  }

  /** Reads back what the bar actually painted, so theme variables are honoured. */
  private _syncInk(): void {
    const fill = this.shadowRoot?.querySelector<HTMLElement>(".fill");
    if (!fill) return;
    const ink = contrastingInk(getComputedStyle(fill).backgroundColor);
    if (ink !== this._ink) this._ink = ink;
  }

  private _measure(): void {
    const card = this.shadowRoot?.querySelector<HTMLElement>("ha-card");
    if (!card) return;

    const rect = card.getBoundingClientRect();
    const height = rect.height;
    if (Math.round(rect.width) !== this._size.w || Math.round(height) !== this._size.h) {
      this._size = { w: Math.round(rect.width), h: Math.round(height) };
    }
    if (height > 0) {
      const scale = clamp(1 + (height - BASE_ROW_HEIGHT) / 220, 1, 1.6);
      if (Math.abs(scale - this._scale) > 0.01) this._scale = scale;
    }

    const name = this._metricsOf(".layer.base .line.name");
    if (this._changed(name, this._name)) this._name = name;

    const secondary = this._metricsOf(".layer.base .line.secondary");
    if (this._changed(secondary, this._secondary)) this._secondary = secondary;
  }

  private _changed(next: LineMetrics, current: LineMetrics): boolean {
    return next.scroll !== current.scroll || Math.abs(next.dist - current.dist) > 1;
  }

  /**
   * Overflow is measured from the text alone so the decision does not flip when
   * the separator is added; the travel distance is one text-plus-separator copy.
   */
  private _metricsOf(selector: string): LineMetrics {
    const line = this.shadowRoot?.querySelector<HTMLElement>(selector);
    if (!line) return EMPTY_METRICS;
    const txt = line.querySelector<HTMLElement>(".txt");
    const chunk = line.querySelector<HTMLElement>(".chunk");
    if (!txt || !chunk) return EMPTY_METRICS;
    const scroll = txt.getBoundingClientRect().width > line.clientWidth + 1;
    return { scroll, dist: scroll ? Math.round(chunk.getBoundingClientRect().width) : 0 };
  }

  private _hasAction(): boolean {
    const tap = this._config?.tap_action?.action ?? "more-info";
    return tap !== "none" || Boolean(this._config?.hold_action) || Boolean(this._config?.double_tap_action);
  }

  private _clearTimers(): void {
    if (this._holdTimer) window.clearTimeout(this._holdTimer);
    if (this._tapTimer) window.clearTimeout(this._tapTimer);
    this._holdTimer = undefined;
    this._tapTimer = undefined;
  }

  private _onPointerDown = (): void => {
    if (!this._hasAction()) return;
    this._held = false;
    this._holdTimer = window.setTimeout(() => {
      this._held = true;
      this._fire("hold");
    }, 500);
  };

  private _onPointerCancel = (): void => {
    if (this._holdTimer) window.clearTimeout(this._holdTimer);
    this._holdTimer = undefined;
  };

  private _onPointerUp = (): void => {
    if (!this._hasAction()) return;
    if (this._holdTimer) window.clearTimeout(this._holdTimer);
    this._holdTimer = undefined;
    if (this._held) return;

    const doubleTap = this._config?.double_tap_action;
    if (!doubleTap || doubleTap.action === "none") {
      this._fire("tap");
      return;
    }
    if (this._tapTimer) {
      window.clearTimeout(this._tapTimer);
      this._tapTimer = undefined;
      this._fire("double_tap");
      return;
    }
    this._tapTimer = window.setTimeout(() => {
      this._tapTimer = undefined;
      this._fire("tap");
    }, 250);
  };

  private _onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    this._fire("tap");
  };

  private _fire(action: "tap" | "hold" | "double_tap"): void {
    if (!this.hass || !this._config) return;
    handleAction(this, this.hass, this._config, action);
  }

  static override get styles() {
    return css`
      :host([hidden]) {
        display: none !important;
      }

      :host {
        display: block;
        height: 100%;
        --pb-scale: 1;
        --pb-radius: 999px;
        --pb-bar-color: var(--primary-color);
      }

      ha-card {
        position: relative;
        display: block;
        height: 100%;
        overflow: hidden;
        border-radius: var(--pb-radius);
        container-type: inline-size;
        box-sizing: border-box;
      }

      ha-card.interactive {
        cursor: pointer;
      }

      ha-card:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
      }

      .fill {
        position: absolute;
        top: 0;
        bottom: 0;
        inset-inline-start: 0;
        width: 0;
        background: var(--pb-bar-color);
        z-index: 1;
        transition:
          width 550ms cubic-bezier(0.4, 0, 0.2, 1),
          background-color 350ms ease;
        will-change: width;
      }

      .layer.base {
        position: relative;
        z-index: 2;
        height: 100%;
        color: var(--primary-text-color);
      }

      /* Clipped copy of the same content, revealed exactly where the bar is. */
      .clip {
        position: absolute;
        top: 0;
        bottom: 0;
        inset-inline-start: 0;
        width: 0;
        overflow: hidden;
        z-index: 3;
        pointer-events: none;
        color: var(--pb-ink-primary);
        transition: width 550ms cubic-bezier(0.4, 0, 0.2, 1);
        will-change: width;
      }

      .clip .secondary {
        color: var(--pb-ink-secondary);
      }

      .content {
        box-sizing: border-box;
        width: 100cqw;
        height: 100%;
        min-height: ${BASE_ROW_HEIGHT}px;
        display: flex;
        align-items: center;
        gap: calc(10px * var(--pb-scale));
        padding: 0 calc(12px * var(--pb-scale));
        transition: opacity ${FADE_MS}ms ease;
      }

      /* Crossfade when cycling between concurrent calendar events. */
      .content.fade {
        opacity: 0;
      }

      .icon {
        flex: 0 0 auto;
        --mdc-icon-size: calc(24px * var(--pb-scale));
        width: calc(24px * var(--pb-scale));
        height: calc(24px * var(--pb-scale));
        color: inherit;
      }

      .text {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      .line {
        position: relative;
        overflow: hidden;
      }

      .track {
        display: inline-flex;
        white-space: nowrap;
      }

      .chunk {
        display: inline-flex;
        flex: 0 0 auto;
      }

      .sep {
        padding: 0 0.65em;
        opacity: 0.45;
      }

      /* Softens the trim at both ends of a line that is scrolling. */
      .line.scroll {
        --pb-fade: calc(10px * var(--pb-scale));
        -webkit-mask-image: linear-gradient(
          to right,
          transparent 0,
          #000 var(--pb-fade),
          #000 calc(100% - var(--pb-fade)),
          transparent 100%
        );
        mask-image: linear-gradient(
          to right,
          transparent 0,
          #000 var(--pb-fade),
          #000 calc(100% - var(--pb-fade)),
          transparent 100%
        );
      }

      .name {
        font-size: calc(15px * var(--pb-scale));
        font-weight: 600;
        line-height: 1.3;
      }

      .secondary {
        font-size: calc(12.5px * var(--pb-scale));
        line-height: 1.35;
        color: var(--secondary-text-color);
      }

      .value {
        flex: 0 0 auto;
        font-size: calc(19px * var(--pb-scale));
        font-weight: 400;
        line-height: 1;
        padding-inline-start: calc(8px * var(--pb-scale));
      }

      /* One word per line, centred, so a wide value costs less width. */
      .value.wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        font-size: calc(15px * var(--pb-scale));
        line-height: 1.12;
      }

      .line.animating .track {
        animation: pb-marquee var(--pb-dur, 8s) linear infinite;
        will-change: transform;
      }

      @keyframes pb-marquee {
        from {
          transform: translateX(0);
        }
        to {
          transform: translateX(calc(-1 * var(--pb-dist, 0px)));
        }
      }


      /* Tall fill: rises from the bottom, behind a giant ghost value. */
      ha-card.tall .fill,
      ha-card.tall .clip {
        top: auto;
        bottom: 0;
        inset-inline-start: 0;
        width: 100%;
        height: 0;
        transition: height 550ms cubic-bezier(0.4, 0, 0.2, 1);
        will-change: height;
      }

      ha-card.tall .clip .content {
        position: absolute;
        bottom: 0;
        inset-inline-start: 0;
        width: 100%;
        height: var(--pb-card-h);
      }

      .content.tall {
        display: block;
        position: relative;
        padding: 0;
      }

      .content.tall .head {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 16px;
      }

      .ghost {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        line-height: 1;
        letter-spacing: -0.04em;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }

      .layer.base .ghost {
        color: var(--primary-text-color);
        opacity: 0.12;
      }

      .clip .ghost {
        color: var(--pb-ink-primary);
        opacity: 0.3;
      }

      /* Ring */
      .ring-box {
        position: relative;
        flex: 0 0 auto;
      }

      .ring-svg {
        display: block;
        width: 100%;
        height: 100%;
        transform: rotate(-90deg);
        fill: none;
        stroke-width: 11;
      }

      .ring-track {
        stroke: color-mix(in srgb, var(--primary-text-color) 14%, transparent);
      }

      .ring-bar {
        stroke: var(--pb-bar-color);
        stroke-linecap: round;
        transition:
          stroke-dashoffset 550ms cubic-bezier(0.4, 0, 0.2, 1),
          stroke 350ms ease;
      }

      .ring-centre {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
      }

      .ring-centre .icon {
        --mdc-icon-size: 22px;
        width: 22px;
        height: 22px;
        color: var(--pb-bar-color);
      }

      .ring-value {
        font-weight: 700;
        line-height: 1;
      }

      .content.ring.stacked {
        flex-direction: column;
        justify-content: center;
        gap: 12px;
        padding: 12px 16px;
      }

      .content.ring.stacked .text {
        flex: 0 0 auto;
        width: 100%;
        text-align: center;
      }

      .content.ring.stacked .ring-centre .icon {
        --mdc-icon-size: 28px;
        width: 28px;
        height: 28px;
      }

      /* Dots */
      .dots-head {
        display: flex;
        align-items: center;
        gap: calc(10px * var(--pb-scale));
        min-width: 0;
        width: 100%;
      }

      .content.dots-layout {
        flex-direction: column;
        align-items: stretch;
        justify-content: flex-start;
        gap: 0;
        padding: 0 8px 8px;
      }

      .content.dots-layout .dots-head {
        flex: 0 0 ${BASE_ROW_HEIGHT}px;
        height: ${BASE_ROW_HEIGHT}px;
        box-sizing: border-box;
        padding: 0 8px;
      }

      .dots {
        flex: 1 1 auto;
        display: grid;
        align-content: space-evenly;
        justify-items: center;
        min-height: 0;
      }

      .dots.inline {
        flex: 0 0 auto;
        gap: 4px 3px;
        align-content: center;
        width: 90px;
      }

      .dot {
        width: var(--pb-dot);
        height: var(--pb-dot);
        border-radius: 50%;
        background: color-mix(in srgb, var(--primary-text-color) 14%, transparent);
        transition: background-color 350ms ease;
      }

      .dot.on {
        background: var(--pb-bar-color);
      }

      .dot.part {
        background: color-mix(in srgb, var(--pb-bar-color) 45%, transparent);
      }

      ha-card.unavailable .layer.base .content {
        opacity: 0.55;
      }

      @media (prefers-reduced-motion: reduce) {
        .fill,
        .clip,
        .ring-bar,
        .dot,
        .content {
          transition: none;
        }
        .line.animating .track {
          animation: none;
        }
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-progress-card": HaProgressCard;
  }
  interface Window {
    customCards?: unknown[];
  }
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_NAME,
  name: "Progress Bar Card",
  description: "A progress bar for any numeric entity, with thresholds and adaptive contrast.",
  preview: true,
  documentationURL: "https://github.com/fwhitten/progress-bar-card",
});
