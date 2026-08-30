import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { CARD_NAME, CARD_VERSION, EDITOR_NAME } from "./const";
import type { HassEntity, HomeAssistant, ProgressCardConfig } from "./types";
import { clamp, colorForValue, contrastingInk, handleAction } from "./utils";

/* eslint-disable no-console */
console.info(
  `%c HA-PROGRESS-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#3f8fd6;font-weight:700;border-radius:4px 0 0 4px;padding:2px 4px",
  "color:#3f8fd6;background:#2b2b2b;border-radius:0 4px 4px 0;padding:2px 4px",
);

const BASE_ROW_HEIGHT = 56;
const UNAVAILABLE_STATES = new Set(["unavailable", "unknown", "none", ""]);

interface Line {
  text: string;
  distance: number;
}

@customElement(CARD_NAME)
export class HaProgressCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config?: ProgressCardConfig;
  @state() private _scale = 1;
  @state() private _nameDistance = 0;
  @state() private _secondaryDistance = 0;
  @state() private _ink: "light" | "dark" = "light";

  private _resizeObserver?: ResizeObserver;
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
      ...config,
    };
  }

  public getCardSize(): number {
    return 1;
  }

  /** Sections view: one row tall by default, never taller than three. */
  public getGridOptions(): Record<string, number> {
    return {
      rows: 1,
      min_rows: 1,
      max_rows: 3,
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
  }

  public override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._clearTimers();
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

  private _formatValue(stateObj: HassEntity, numeric: number, percentage: number): string {
    const config = this._config!;
    const unit = this._unit(stateObj);
    const mode = config.value_mode ?? "auto";
    const usePercentage =
      mode === "percentage" || (mode === "auto" && (unit === "%" || unit === undefined));

    if (usePercentage) {
      return `${Math.round(percentage)}%`;
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

  protected override render(): TemplateResult | typeof nothing {
    if (!this._config || !this.hass) return nothing;

    const stateObj = this._stateObj;
    const radius =
      this._config.shape === "theme" ? "var(--ha-card-border-radius, 12px)" : "999px";

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

    const raw = this._rawValue(stateObj);
    const numeric = Number(raw);
    const available = !UNAVAILABLE_STATES.has(stateObj.state) && !Number.isNaN(numeric);

    const min = Number(this._config.min ?? 0);
    const max = Number(this._config.max ?? 100);
    const span = max - min;
    const percentage = available && span !== 0 ? clamp(((numeric - min) / span) * 100, 0, 100) : 0;

    const barColor = colorForValue(numeric, this._config.thresholds, this._config.bar_color);
    const name = this._config.name ?? stateObj.attributes.friendly_name ?? stateObj.entity_id;
    const valueText = available
      ? this._formatValue(stateObj, numeric, percentage)
      : this.hass.formatEntityState?.(stateObj) ?? stateObj.state;

    const nameLine: Line = { text: name, distance: this._nameDistance };
    const secondaryLine: Line = { text: this._secondaryText(), distance: this._secondaryDistance };
    const showValue = this._config.show_value !== false;

    const hostStyle = styleMap({
      "--pb-radius": radius,
      "--pb-scale": String(this._scale),
      "--pb-bar-color": barColor,
      "--pb-ink-primary": this._ink === "dark" ? "rgba(0, 0, 0, 0.92)" : "rgba(255, 255, 255, 0.98)",
      "--pb-ink-secondary": this._ink === "dark" ? "rgba(0, 0, 0, 0.66)" : "rgba(255, 255, 255, 0.78)",
    });
    const fillStyle = styleMap({ width: `${available ? percentage : 0}%` });

    return html`
      <ha-card
        style=${hostStyle}
        class=${classMap({ unavailable: !available, interactive: this._hasAction() })}
        role=${this._hasAction() ? "button" : "presentation"}
        tabindex=${this._hasAction() ? "0" : "-1"}
        @pointerdown=${this._onPointerDown}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerCancel}
        @pointerleave=${this._onPointerCancel}
        @keydown=${this._onKeyDown}
      >
        <div class="fill" style=${fillStyle}></div>
        <div class="layer base">${this._renderContent(stateObj, nameLine, secondaryLine, valueText, showValue)}</div>
        <div class="clip" style=${fillStyle}>
          ${this._renderContent(stateObj, nameLine, secondaryLine, valueText, showValue)}
        </div>
      </ha-card>
    `;
  }

  /**
   * Rendered twice: once against the card background and once inside the bar's
   * clipping box. Keeping both copies identical is what lets a glyph sitting on
   * the fill edge be half one colour and half the other.
   */
  private _renderContent(
    stateObj: HassEntity,
    name: Line,
    secondary: Line,
    valueText: string,
    showValue: boolean,
  ): TemplateResult {
    const icon = this._config?.icon;
    return html`
      <div class="content">
        ${icon
          ? html`<ha-icon class="icon" .icon=${icon}></ha-icon>`
          : html`<ha-state-icon
              class="icon"
              .hass=${this.hass}
              .stateObj=${stateObj}
            ></ha-state-icon>`}
        <div class="text">
          <div
            class=${classMap({ line: true, name: true, scroll: name.distance > 0 })}
            style=${styleMap({
              "--pb-dist": `${name.distance}px`,
              "--pb-dur": `${this._duration(name.distance)}s`,
            })}
          >
            <span>${name.text}</span>
          </div>
          ${secondary.text
            ? html`<div
                class=${classMap({ line: true, secondary: true, scroll: secondary.distance > 0 })}
                style=${styleMap({
                  "--pb-dist": `${secondary.distance}px`,
                  "--pb-dur": `${this._duration(secondary.distance)}s`,
                })}
              >
                <span>${secondary.text}</span>
              </div>`
            : nothing}
        </div>
        ${showValue ? html`<div class="value">${valueText}</div>` : nothing}
      </div>
    `;
  }

  private _duration(distance: number): number {
    return Math.max(5, Math.round(distance / 22));
  }

  protected override firstUpdated(): void {
    this._resizeObserver ??= new ResizeObserver(() => this._measure());
    this._resizeObserver.observe(this);
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    this._measure();
    this._syncInk();
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

    const height = card.getBoundingClientRect().height;
    if (height > 0) {
      const scale = clamp(1 + (height - BASE_ROW_HEIGHT) / 220, 1, 1.6);
      if (Math.abs(scale - this._scale) > 0.01) this._scale = scale;
    }

    const nameDistance = this._overflowOf(".layer.base .line.name");
    if (Math.abs(nameDistance - this._nameDistance) > 1) this._nameDistance = nameDistance;

    const secondaryDistance = this._overflowOf(".layer.base .line.secondary");
    if (Math.abs(secondaryDistance - this._secondaryDistance) > 1) {
      this._secondaryDistance = secondaryDistance;
    }
  }

  private _overflowOf(selector: string): number {
    const line = this.shadowRoot?.querySelector<HTMLElement>(selector);
    const span = line?.firstElementChild as HTMLElement | null;
    if (!line || !span) return 0;
    return Math.max(0, Math.round(span.scrollWidth - line.clientWidth));
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

      .line > span {
        display: inline-block;
        white-space: nowrap;
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

      .line.scroll > span {
        animation: pb-marquee var(--pb-dur, 8s) linear infinite alternate;
        will-change: transform;
      }

      @keyframes pb-marquee {
        0%,
        12% {
          transform: translateX(0);
        }
        88%,
        100% {
          transform: translateX(calc(-1 * var(--pb-dist, 0px)));
        }
      }

      ha-card.unavailable .layer.base .content {
        opacity: 0.55;
      }

      @media (prefers-reduced-motion: reduce) {
        .fill,
        .clip {
          transition: none;
        }
        .line.scroll > span {
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
