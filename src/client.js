/**
 * dsh-better-goal — zero-build browser half.
 *
 * One module-loader closure (`id: "dsh-better-goal"`) contributes:
 *   1. the independent GoalBar in `conversation.input.dock`, reading the
 *      native `goal` session projection and mutating through the shipped
 *      `remote.goals` RPC;
 *   2. the row configuration page in `plugins.row.config`, rendered from the
 *      native volatile Config and written through the native settings form.
 *
 * Independence: this file requires only React. It never imports Apollo and
 * owns no remote namespace of its own. `remote.goals` supplies both the
 * read-only activation lookup and the CAS-checked edit/pause/resume/clear
 * verbs; no slash-command lifecycle is involved, so UI actions leave no
 * command/run or implementation details in the chat. The CAS ref is read from
 * the live session projection at click time (not from the rendered snapshot),
 * so a stale render cannot become the authority.
 *
 * Styling follows the shipped DSH design tokens and the native GoalBar's
 * geometry. Everything is scoped under `dbg-` classes; no shadcn, no build.
 */

window.__ModuleLoader__.load({
  id: 'dsh-better-goal',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const {
      createElement: h,
      useCallback,
      useEffect,
      useRef,
      useState,
    } = React

    /** Locale namespace owned by this closure. */
    const NS = 'better-goal'
    /** Must stay in sync with src/config.js. */
    const ROW_KEY = 'dsh-better-goal#dsh-better-goal'
    /**
     * Apollo's bundle patch re-declares the same top-level row. The Plugins page
     * keys a row's configuration by its declaring bundle and row id, so the
     * Apollo-only assembly looks the page up as `dsh-apollo#dsh-better-goal`.
     * Registering the same page under both exact keys keeps the independent
     * plugin's config namespace and store unchanged in either assembly.
     */
    const APOLLO_ROW_KEY = 'dsh-apollo#dsh-better-goal'
    /** Both assemblies' `plugins.row.config` keys, in dispatch order. */
    const ROW_CONFIG_KEYS = Object.freeze([ROW_KEY, APOLLO_ROW_KEY])
    const ROUND_LIMIT_MODES = Object.freeze(['agent', 'unlimited', 'fixed'])
    const DEFAULT_ROUND_LIMIT = 256
    const DEFAULT_QUESTION_TIMEOUT_SECONDS = 120
    const MAX_QUESTION_TIMEOUT_SECONDS = 2147483
    const UNLIMITED_ROUNDS = Number.MAX_SAFE_INTEGER
    const STYLE_GOAL = 'dsh-better-goal/goal.css'
    const STYLE_SETTINGS = 'dsh-better-goal/settings.css'

    // ── Copy ────────────────────────────────────────────────────────────────

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      summary: '独立目标条、轮数上限策略与目标提问超时',
      waitingForm: '正在等待宿主提供这一行的配置快照…',
      noFormHint: '长时间停在这里说明宿主没有为这一行提供可编辑配置：本部署没组合 dsh-settings/config-editor，或本行的 Config 未被识别。',
      loading: '正在读取配置…',
      unavailable: '当前连接下该配置不可用：请通过 loopback 地址访问，或在行配置里把该权威加入 trustedHosts。',
      readonly: '当前连接只读（设置镜像为进程内 memory），无法写入宿主配置。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，即时生效。',
      conflict: '宿主拒绝了这次写入：配置可能已被其他改动更新或被更高优先级配置覆盖，已重新读取宿主值。',
      saveFailed: '保存失败：',
      reset: '放弃改动',
      modeLabel: '轮数上限策略',
      modeAgent: '由 Agent 决定',
      modeAgentHint: '模型可传入 max_goal_rounds；不传且非编辑已有目标时使用无上限。',
      modeUnlimited: '无上限',
      modeUnlimitedHint: '忽略模型传入的轮数上限，使用兼容哨兵（UI 显示为无上限）。',
      modeFixed: '固定轮数',
      modeFixedHint: '始终使用下面填写的固定上限，忽略模型传入值。',
      roundLimitLabel: '固定轮数上限',
      roundLimitHint: '仅“固定轮数”模式生效；必须是 1 到 9007199254740991 之间的正整数。',
      roundLimitUnlimited: '当前值等于兼容哨兵，界面显示为无上限。',
      questionTimeoutLabel: '目标提问超时（秒）',
      questionTimeoutHint: '-1 表示永不超时；否则为 1 到 2147483 的整数。热设置只影响新发起的等待，不改变当前等待。',
      questionTimeoutNever: '当前设置：永不超时。',
      invalidMode: '请选择一种轮数上限策略。',
      invalidRoundLimit: '固定轮数必须是 1 到 9007199254740991 之间的正整数。',
      invalidQuestionTimeout: '提问超时必须是 -1，或 1 到 2147483 之间的整数。',
      readonlyNote: '只读：当前无法写入宿主配置。',
      unavailableNote: '不可写：当前连接下该配置不可用。',
      settingsTitle: '目标运行设置',
      settingsIntro: '保存后即时生效，无需重启。热设置只影响新发起的目标轮次与提问等待。',
      'phase.active': '进行中的目标',
      'phase.active.disarmed': '已暂停的目标',
      'phase.paused': '已暂停的目标',
      'phase.blocked': '受阻的目标',
      'objective.aria': '目标内容',
      'edit.placeholder': '输入新的目标内容',
      'action.save': '保存目标',
      'action.cancel': '取消编辑',
      'action.pause': '暂停目标',
      'action.resume': '恢复目标',
      'action.edit': '编辑目标',
      'action.clear': '清除目标',
      'cap.unlimited': '无上限',
      'meta.rounds': '第 {rounds} / {max} 轮',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      summary: 'Standalone GoalBar, round-cap policy, and goal-question timeout',
      waitingForm: 'Waiting for the host to provide this row’s configuration snapshot…',
      noFormHint: 'Staying here means the host exposes no editable config for this row: dsh-settings/config-editor is not composed, or this row’s Config was not recognized.',
      loading: 'Loading configuration…',
      unavailable: 'This configuration is unavailable on the current connection: use a loopback address, or list this authority in the row config trustedHosts.',
      readonly: 'This connection is read-only (settings mirror is process-local memory); host configuration cannot be written.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved and applied.',
      conflict: 'The host refused this write: the configuration changed elsewhere or a higher layer overrides it. Host values were reloaded.',
      saveFailed: 'Save failed: ',
      reset: 'Discard',
      modeLabel: 'Round-cap policy',
      modeAgent: 'Agent decides',
      modeAgentHint: 'The model may pass max_goal_rounds; omission on create (and no current cap on edit) means unlimited.',
      modeUnlimited: 'Unlimited',
      modeUnlimitedHint: 'Ignore model-supplied caps and use the compatibility sentinel (rendered as unlimited).',
      modeFixed: 'Fixed rounds',
      modeFixedHint: 'Always use the fixed cap below; model-supplied values are ignored.',
      roundLimitLabel: 'Fixed round cap',
      roundLimitHint: 'Used only in Fixed rounds mode; a positive integer from 1 to 9007199254740991.',
      roundLimitUnlimited: 'This value is the compatibility sentinel; the UI renders it as unlimited.',
      questionTimeoutLabel: 'Goal-question timeout (seconds)',
      questionTimeoutHint: '-1 never times out; otherwise an integer from 1 to 2147483. Hot changes affect only newly started waits, never the current one.',
      questionTimeoutNever: 'Current setting: never times out.',
      invalidMode: 'Choose a round-cap policy.',
      invalidRoundLimit: 'The fixed cap must be a positive integer from 1 to 9007199254740991.',
      invalidQuestionTimeout: 'The timeout must be -1 or an integer from 1 to 2147483.',
      readonlyNote: 'Read-only: host configuration cannot be written.',
      unavailableNote: 'Not writable: this configuration is unavailable on the current connection.',
      settingsTitle: 'Goal runtime settings',
      settingsIntro: 'Saving applies immediately, no restart. Hot changes affect only newly started goal rounds and question waits.',
      'phase.active': 'Ongoing Goal',
      'phase.active.disarmed': 'Inactive Goal',
      'phase.paused': 'Paused Goal',
      'phase.blocked': 'Blocked Goal',
      'objective.aria': 'Goal objective',
      'edit.placeholder': 'Enter a new goal objective',
      'action.save': 'Save goal',
      'action.cancel': 'Cancel edit',
      'action.pause': 'Pause goal',
      'action.resume': 'Resume goal',
      'action.edit': 'Edit goal',
      'action.clear': 'Clear goal',
      'cap.unlimited': 'unlimited',
      'meta.rounds': 'Round {rounds} / {max}',
    }

    /** Interpolate `{name}` placeholders for the local fallback. */
    function interpolate(text, params) {
      if (params === undefined || params === null) return text
      return text.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    /** Local Chinese fallback used before/without the locale service. */
    let fallbackT = (key, params) => interpolate(zh[key] ?? key, params)

    /** Translate through a framework seat when supplied, else the fallback. */
    function tr(t, key, params) {
      return (typeof t === 'function' ? t : fallbackT)(key, params)
    }

    // ── GoalBar styles (native geometry + DSH tokens) ──────────────────────

    const GOAL_CSS = [
      '.dbg-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto}',
      '.dbg-bar{isolation:isolate;box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);height:36px;box-shadow:var(--dsw-elevation-panel);border:0;align-items:center;gap:10px;margin:0 auto;padding:4px 5px 4px 12px;display:flex;position:relative}',
      '.dbg-bar:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
      '.dbg-goalGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}',
      '.dbg-label{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}',
      '.dbg-objective{min-width:0;color:var(--dsw-alias-label-primary-dimmed);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;line-height:20px;overflow:hidden}',
      '.dbg-meta{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;font-size:11.5px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.dbg-error{min-width:0;color:var(--dsw-alias-state-error-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;line-height:20px;overflow:hidden}',
      '.dbg-editBar{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);align-items:center;height:auto;min-height:36px}',
      '.dbg-editInput{box-sizing:border-box;flex:1;min-width:0;height:26px;padding:0 2px;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}',
      '.dbg-editInput::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.dbg-editInput:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;border-radius:var(--dsw-radius-sm)}',
      '.dbg-actions{flex:none;align-items:center;gap:2px;display:flex}',
      '.dbg-iconBtn{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;justify-content:center;align-items:center;padding:0;display:inline-flex}',
      '.dbg-iconBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dbg-iconBtn:disabled{opacity:.4;cursor:default}',
      '.dbg-iconBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '@media (max-width:560px){.dbg-meta{display:none}}',
    ].join('\n')

    // ── Settings form styles ───────────────────────────────────────────────

    const SETTINGS_CSS = [
      '.dbg-cfg{display:flex;flex-direction:column;gap:12px;max-width:760px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dbg-note{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12.5px;line-height:18px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}',
      '.dbg-note[data-tone=warn]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary)}',
      '.dbg-note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
      '.dbg-note[data-tone=error]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dbg-pulse{animation:dbg-pulse 2s cubic-bezier(.36,0,.64,1) infinite}',
      '@keyframes dbg-pulse{0%{opacity:1}40%{opacity:.6}80%,to{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dbg-pulse{animation:none}}',
      '.dbg-title{margin:0;font-size:14px;font-weight:500;line-height:22px}',
      '.dbg-hint{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.dbg-intro{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.dbg-section{display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dbg-sectionHead{display:flex;flex-direction:column;gap:2px;padding-bottom:4px}',
      '.dbg-field{display:grid;grid-template-columns:minmax(120px,168px) minmax(0,1fr);gap:2px 12px;padding:6px 0;align-items:start}',
      '.dbg-fieldLabel{padding-top:5px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dbg-fieldBody{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dbg-input,.dbg-select{box-sizing:border-box;width:100%;min-width:0;height:28px;padding:0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}',
      '.dbg-select{appearance:none;background-image:none;padding-right:24px}',
      '.dbg-input:focus,.dbg-select:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
      '.dbg-input:focus-visible,.dbg-select:focus-visible,.dbg-button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.dbg-input:disabled,.dbg-select:disabled{opacity:.4;cursor:not-allowed}',
      '.dbg-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}',
      '.dbg-footer{display:flex;align-items:center;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.dbg-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}',
      '.dbg-button:disabled{opacity:.4;cursor:not-allowed}',
      '.dbg-button[data-variant=primary]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-label-primary));color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-3))}',
      '.dbg-button[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-label-primary))}',
      '.dbg-button[data-variant=outline]{border:.5px solid var(--dsw-alias-border-l3)}',
      '.dbg-button[data-variant=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dbg-status{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dbg-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}',
      '.dbg-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}',
      '.dbg-status[data-tone=warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}',
      '@media (max-width:640px){.dbg-field{grid-template-columns:minmax(0,1fr)}.dbg-fieldLabel{padding-top:0}}',
    ].join('\n')

    // ── Icons (inline SVG keeps this closure dependency-free) ──────────────

    function iconSvg(children) {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      }, children)
    }

    function IconGoal() {
      return iconSvg([
        h('circle', { key: 'outer', cx: 8, cy: 8, r: 5.5, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('circle', { key: 'inner', cx: 8, cy: 8, r: 1.6, fill: 'currentColor' }),
      ])
    }

    function IconPause() {
      return iconSvg([
        h('rect', { key: 'left', x: 4.5, y: 3.5, width: 2.2, height: 9, rx: 1, fill: 'currentColor' }),
        h('rect', { key: 'right', x: 9.3, y: 3.5, width: 2.2, height: 9, rx: 1, fill: 'currentColor' }),
      ])
    }

    function IconPlay() {
      return iconSvg(h('path', { d: 'M5.4 3.7 12.2 8l-6.8 4.3Z', fill: 'currentColor' }))
    }

    function IconEdit() {
      return iconSvg(h('path', {
        d: 'M10.4 2.6 13.4 5.6 6.1 12.9 2.8 13.6 3.5 10.3Z',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }))
    }

    function IconTrash() {
      return iconSvg([
        h('path', { key: 'lid', d: 'M3 4.5h10M6.4 4.5V3h3.2v1.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'body', d: 'M4.4 4.5 5 12.5h6l.6-8M6.8 7v3.2M9.2 7v3.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ])
    }

    function IconCheck() {
      return iconSvg(h('path', { d: 'm3.5 8.4 3.1 3.1 5.9-6.9', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function IconClose() {
      return iconSvg(h('path', { d: 'm4.5 4.5 7 7m0-7-7 7', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    // ── Shared small helpers ───────────────────────────────────────────────

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function isPositiveSafeInteger(value) {
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    }

    function isValidQuestionTimeout(value) {
      if (value === -1) return true
      return Number.isSafeInteger(value) && value >= 1 && value <= MAX_QUESTION_TIMEOUT_SECONDS
    }

    function isUnlimitedCap(value) {
      return value === UNLIMITED_ROUNDS
    }

    function failure(code, message) {
      return { ok: false, error: { code, message } }
    }

    function errorText(result) {
      const error = result?.error
      if (typeof error?.message === 'string' && error.message !== '') {
        return typeof error?.code === 'string' && error.code !== ''
          ? `${error.message} (${error.code})`
          : error.message
      }
      return 'goal action failed'
    }

    // ── Goal Remote mutations (CAS ref read at verb call time) ─────────────

    /** Read the session's CURRENT projected CAS ref at verb call time. */
    function currentGoalRef(ctx, sessionId) {
      try {
        const projection = ctx.sessions?.binding(sessionId)?.session?.projections?.faceOf('goal')?.getSnapshot()
        if (!isRecord(projection) || !isRecord(projection.goal)) return undefined
        const { id, revision } = projection.goal
        if (typeof id !== 'string' || id === '' || !Number.isSafeInteger(revision) || revision < 1) return undefined
        return { id, revision }
      } catch {
        return undefined
      }
    }

    /** The one failure the strip reports without a wire call. */
    const noCurrentGoal = {
      ok: false,
      error: {
        code: 'no-current-goal',
        message: 'no current goal to mutate',
      },
    }

    /**
     * Injected mutation verbs for one docked session. The CAS ref is the
     * session's live projection read at call time; the host Remote enforces it.
     * These are the shipped native goal RPCs — no slash-command lifecycle, so
     * a UI action leaves no command/run or implementation JSON in the chat.
     */
    function createGoalActions(ctx, sessionId) {
      const refOf = () => currentGoalRef(ctx, sessionId)
      return {
        onEdit: async (objective) => {
          const ref = refOf()
          if (ref === undefined) return noCurrentGoal
          return ctx.remote.goals.edit(sessionId, ref, { objective })
        },
        onPause: async () => {
          const ref = refOf()
          if (ref === undefined) return noCurrentGoal
          return ctx.remote.goals.pause(sessionId, ref)
        },
        onResume: async () => {
          const ref = refOf()
          if (ref === undefined) return noCurrentGoal
          return ctx.remote.goals.resume(sessionId, ref)
        },
        onClear: async () => {
          const ref = refOf()
          if (ref === undefined) return noCurrentGoal
          return ctx.remote.goals.clear(sessionId, ref)
        },
      }
    }

    // ── Process-local activation (read-only remote.goals.get) ──────────────

    /** Snapshot equality for the activation source. */
    function sameActivation(left, right) {
      return left.id === right.id && left.revision === right.revision && left.activation === right.activation
    }

    /**
     * Registrant-private activation observable.
     *
     * Activation is process-local and deliberately absent from the durable
     * `goal` projection. This source mirrors the shipped ui-goal client: one
     * read-only `remote.goals.get` initializes it, and the native
     * `goal/activation-changed` event plus `connection/reset` keep it current.
     * Mutations use the separate CAS-checked goal Remote verbs.
     *
     * The source subscribes only while a framework hook observes it; stopping
     * all observers releases the Remote/projection/session listeners.
     */
    function createGoalActivationSource(deps) {
      let snapshot = {}
      let subscriptions = 0
      let disposers = []
      let running = deps.session.getSnapshot().running
      let eventEpoch = 0
      let projectionEpoch = 0
      let readEpoch = 0
      const listeners = new Set()

      const publish = (next) => {
        if (sameActivation(snapshot, next)) return
        snapshot = next
        for (const listener of listeners) listener()
      }

      /** Current active CAS ref from the durable projection, if any. */
      const activeRef = () => {
        const projection = deps.projection.getSnapshot()
        if (!isRecord(projection) || !isRecord(projection.goal) || projection.goal.phase !== 'active') return undefined
        return { id: projection.goal.id, revision: projection.goal.revision }
      }

      /** One live activation read, fenced against newer events/projections. */
      const startRead = (ref) => {
        if (ref === undefined) return
        const read = ++readEpoch
        const startedAtEvent = eventEpoch
        const startedAtProjection = projectionEpoch
        Promise.resolve()
          .then(() => deps.getGoal())
          .then((result) => {
            if (read !== readEpoch || startedAtEvent !== eventEpoch || startedAtProjection !== projectionEpoch) return
            if (!result || result.ok !== true) return
            const goal = result.value
            if (goal === undefined) {
              // The durable projection is the authoritative clear edge; an
              // active projection with no live goal is transient.
              if (activeRef() === undefined) publish({})
              return
            }
            publish({ id: goal.id, revision: goal.revision, activation: goal.activation })
          }, (error) => {
            console.warn('[dsh-better-goal] goal activation read failed:', error)
          })
      }

      const refreshProjection = () => {
        projectionEpoch++
        const ref = activeRef()
        if (ref === undefined) {
          if (snapshot.id !== undefined) publish({})
          return
        }
        if (snapshot.id !== ref.id || snapshot.revision !== ref.revision) {
          publish({ id: ref.id, revision: ref.revision })
        }
        startRead(ref)
      }

      const onActivation = (goal) => {
        eventEpoch++
        readEpoch++
        publish(goal === undefined
          ? {}
          : { id: goal.id, revision: goal.revision, activation: goal.activation })
      }

      const onRunning = () => {
        const next = deps.session.getSnapshot().running
        if (next === running) return
        running = next
        startRead(activeRef())
      }

      const onReset = () => {
        eventEpoch++
        projectionEpoch++
        startRead(activeRef())
      }

      const start = () => {
        disposers = [
          deps.projection.subscribe(refreshProjection),
          deps.session.subscribe(onRunning),
          deps.subscribeActivation(onActivation),
          deps.subscribeReset(onReset),
        ]
        running = deps.session.getSnapshot().running
        refreshProjection()
      }

      const stop = () => {
        for (const dispose of disposers) dispose()
        disposers = []
        readEpoch++
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          if (subscriptions === 0) start()
          subscriptions++
          return () => {
            listeners.delete(listener)
            subscriptions--
            if (subscriptions === 0) stop()
          }
        },
      }
    }

    /**
     * Injected face of one dock entry: mutation verbs plus the private
     * activation observable. Both use the shipped `remote.goals` RPC; the
     * activation read is read-only and every write carries a fresh CAS ref.
     */
    function createGoalDockFace(ctx, sessionId) {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) throw new Error(`dsh-better-goal: session "${sessionId}" is unavailable`)
      const actions = createGoalActions(ctx, sessionId)
      const goalActivation = createGoalActivationSource({
        projection: binding.session.projections.faceOf('goal'),
        session: binding.session,
        getGoal: async () => {
          if (ctx.sessions.binding(sessionId) !== binding) {
            throw new Error(`dsh-better-goal: session "${sessionId}" is unavailable`)
          }
          return ctx.sessions.using(sessionId, { source: 'betterGoalActivation' }, async (reference) => {
            const state = reference.binding.session.getSnapshot()
            if (state.openState !== 'open') {
              throw state.openError ?? new Error(`session "${sessionId}" is not open`)
            }
            return ctx.remote.goals.get(sessionId)
          })
        },
        subscribeActivation: (listener) => ctx.remote.$on('goal/activation-changed', (event) => {
          if (event.sessionId === sessionId) listener(event.goal)
        }),
        subscribeReset: (listener) => ctx.on('connection/reset', listener),
      })
      return { hooks: { goalActivation }, ...actions }
    }

    // ── GoalBar ────────────────────────────────────────────────────────────

    /** One icon button with a native tooltip (title) and an aria label. */
    function IconButton({ label, disabled, onClick, children }) {
      return h('button', {
        type: 'button',
        className: 'dbg-iconBtn',
        title: label,
        'aria-label': label,
        disabled: disabled === true,
        onClick,
      }, children)
    }

    /**
     * Durable goal strip. `goal === undefined` means the projection capability
     * is absent/loading; `null` means no current goal; complete goals hide.
     * Creation stays on `/goal`; this strip only edits/stops a current goal.
     */
    function GoalBar({
      goal,
      roundsStarted,
      activation,
      onEdit,
      onPause,
      onResume,
      onClear,
      t,
    }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('')
      const [pending, setPending] = useState(false)
      const [actionError, setActionError] = useState(null)
      const [clearedGoalId, setClearedGoalId] = useState(null)
      const pendingRef = useRef(false)
      const goalId = goal?.id
      const revision = goal?.revision

      useEffect(() => {
        setEditing(false)
        setClearedGoalId(null)
      }, [goalId])

      useEffect(() => {
        setActionError(null)
      }, [goalId, revision])

      const runAction = useCallback(async (action) => {
        if (pendingRef.current) return undefined
        pendingRef.current = true
        setPending(true)
        setActionError(null)
        let result
        try {
          result = await action()
        } catch (error) {
          result = failure('action-failed', String(error?.message ?? error))
        }
        pendingRef.current = false
        setPending(false)
        if (!result || result.ok !== true) setActionError(errorText(result))
        return result
      }, [])

      const handleEdit = useCallback(async () => {
        const objective = draft.trim()
        if (objective === '') return
        const result = await runAction(() => onEdit(objective))
        if (result?.ok === true) setEditing(false)
      }, [draft, onEdit, runAction])

      const handleClear = useCallback(async (clearedId) => {
        const result = await runAction(onClear)
        if (result?.ok === true) setClearedGoalId(clearedId)
      }, [onClear, runAction])

      if (goal === undefined || goal === null || goal.phase === 'complete' || goal.id === clearedGoalId) return null

      if (editing) {
        return h('div', { className: 'dbg-dock', 'data-goal-bar': 'dsh-better-goal' },
          h('style', { 'data-plugin-css': STYLE_GOAL }, GOAL_CSS),
          h('div', { className: 'dbg-bar dbg-editBar' },
            h('input', {
              className: 'dbg-editInput',
              type: 'text',
              value: draft,
              placeholder: tr(t, 'edit.placeholder'),
              'aria-label': tr(t, 'objective.aria'),
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                }
              },
            }),
            actionError !== null ? h('span', { className: 'dbg-error', role: 'alert', title: actionError }, actionError) : null,
            h('div', { className: 'dbg-actions' },
              h(IconButton, {
                label: tr(t, 'action.save'),
                disabled: pending || draft.trim() === '',
                onClick: handleEdit,
              }, h(IconCheck)),
              h(IconButton, {
                label: tr(t, 'action.cancel'),
                disabled: pending,
                onClick: () => setEditing(false),
              }, h(IconClose))),
          ))
      }

      const phaseLabel = goal.phase === 'active'
        ? (activation === 'disarmed' ? tr(t, 'phase.active.disarmed') : tr(t, 'phase.active'))
        : goal.phase === 'paused'
          ? tr(t, 'phase.paused')
          : tr(t, 'phase.blocked')
      const showResume = goal.phase === 'paused' || goal.phase === 'blocked'
        || (goal.phase === 'active' && activation === 'disarmed')
      // Unknown activation (initial live read pending) shows neither verb; the
      // durable paused/blocked phases are unambiguous and always resumable.
      const showPause = goal.phase === 'active' && activation === 'armed'
      const title = goal.phase === 'blocked' ? goal.blockedReason?.message : goal.objective
      const rounds = Number.isSafeInteger(roundsStarted) && roundsStarted >= 0 ? roundsStarted : undefined
      const capLabel = isUnlimitedCap(goal.maxGoalRounds) ? tr(t, 'cap.unlimited') : String(goal.maxGoalRounds)

      return h('div', { className: 'dbg-dock', 'data-goal-bar': 'dsh-better-goal' },
        h('style', { 'data-plugin-css': STYLE_GOAL }, GOAL_CSS),
        h('div', { className: 'dbg-bar', title, 'aria-busy': pending ? true : undefined },
          h('span', { className: 'dbg-goalGlyph' }, h(IconGoal)),
          h('span', { className: 'dbg-label' }, phaseLabel),
          actionError !== null
            ? h('span', { className: 'dbg-error', role: 'alert', title: actionError }, actionError)
            : h('span', { className: 'dbg-objective', title: goal.objective }, goal.objective),
          rounds === undefined
            ? null
            : h('span', { className: 'dbg-meta' }, tr(t, 'meta.rounds', { rounds, max: capLabel })),
          h('div', { className: 'dbg-actions' },
            showPause
              ? h(IconButton, {
                label: tr(t, 'action.pause'),
                disabled: pending,
                onClick: () => runAction(onPause),
              }, h(IconPause))
              : null,
            showResume
              ? h(IconButton, {
                label: tr(t, 'action.resume'),
                disabled: pending,
                onClick: () => runAction(onResume),
              }, h(IconPlay))
              : null,
            h(IconButton, {
              label: tr(t, 'action.edit'),
              disabled: pending,
              onClick: () => {
                setDraft(goal.objective)
                setActionError(null)
                setEditing(true)
              },
            }, h(IconEdit)),
            h(IconButton, {
              label: tr(t, 'action.clear'),
              disabled: pending,
              onClick: () => handleClear(goal.id),
            }, h(IconTrash))),
        ))
    }

    /** Dock adapter: durable projection plus the private activation observable. */
    function GoalDock({
      useProjection,
      useGoalActivation,
      onEdit,
      onPause,
      onResume,
      onClear,
      t,
    }) {
      const projection = typeof useProjection === 'function' ? useProjection('goal') : undefined
      const goal = projection === undefined || projection === null ? projection : projection.goal
      const goalId = goal?.id
      const revision = goal?.revision
      const activation = typeof useGoalActivation === 'function'
        ? useGoalActivation((next) => next.id === goalId && next.revision === revision ? next.activation : undefined)
        : undefined
      return h(GoalBar, {
        goal,
        roundsStarted: projection === undefined || projection === null ? undefined : projection.roundsStarted,
        activation,
        onEdit,
        onPause,
        onResume,
        onClear,
        t,
      })
    }

    // ── Settings form (native row config) ──────────────────────────────────

    /** Normalize host values into the editable form shape, falling back to defaults. */
    function shapeConfig(value) {
      const source = isRecord(value) ? value : {}
      return {
        roundLimitMode: ROUND_LIMIT_MODES.includes(source.roundLimitMode) ? source.roundLimitMode : 'agent',
        roundLimit: isPositiveSafeInteger(source.roundLimit) ? source.roundLimit : DEFAULT_ROUND_LIMIT,
        questionTimeoutSeconds: isValidQuestionTimeout(source.questionTimeoutSeconds)
          ? source.questionTimeoutSeconds
          : DEFAULT_QUESTION_TIMEOUT_SECONDS,
      }
    }

    /** Host shape → raw text draft (empty/invalid text stays editable). */
    function toDraft(config) {
      return {
        roundLimitMode: config.roundLimitMode,
        roundLimit: String(config.roundLimit),
        questionTimeoutSeconds: String(config.questionTimeoutSeconds),
      }
    }

    function sameConfig(left, right) {
      return left.roundLimitMode === right.roundLimitMode
        && left.roundLimit === right.roundLimit
        && left.questionTimeoutSeconds === right.questionTimeoutSeconds
    }

    function parsePositiveSafeIntegerText(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.trim()
      if (!/^[0-9]+$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      return Number.isSafeInteger(value) && value >= 1 && value <= UNLIMITED_ROUNDS ? value : undefined
    }

    function parseQuestionTimeoutText(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.trim()
      if (trimmed === '-1') return -1
      const value = parsePositiveSafeIntegerText(trimmed)
      return value !== undefined && value <= MAX_QUESTION_TIMEOUT_SECONDS ? value : undefined
    }

    /**
     * Validate one text draft and produce the JSON value to write.
     * The hidden round-limit text is ignored outside `fixed` mode: the host
     * value stands, so switching modes never writes a value the user cannot see.
     */
    function parseDraft(draft, host) {
      if (!ROUND_LIMIT_MODES.includes(draft.roundLimitMode)) return { error: 'invalidMode' }
      let roundLimit = host.roundLimit
      if (draft.roundLimitMode === 'fixed') {
        const parsed = parsePositiveSafeIntegerText(draft.roundLimit)
        if (parsed === undefined) return { error: 'invalidRoundLimit' }
        roundLimit = parsed
      }
      const questionTimeoutSeconds = parseQuestionTimeoutText(draft.questionTimeoutSeconds)
      if (questionTimeoutSeconds === undefined) return { error: 'invalidQuestionTimeout' }
      return {
        value: {
          roundLimitMode: draft.roundLimitMode,
          roundLimit,
          questionTimeoutSeconds,
        },
      }
    }

    /** One atomic namespace mutation carrying only changed volatile fields. */
    function diffOps(host, next) {
      const ops = []
      if (host.roundLimitMode !== next.roundLimitMode) {
        ops.push({ op: 'set', path: ['roundLimitMode'], value: next.roundLimitMode })
      }
      if (host.roundLimit !== next.roundLimit) {
        ops.push({ op: 'set', path: ['roundLimit'], value: next.roundLimit })
      }
      if (host.questionTimeoutSeconds !== next.questionTimeoutSeconds) {
        ops.push({ op: 'set', path: ['questionTimeoutSeconds'], value: next.questionTimeoutSeconds })
      }
      return ops
    }

    /** Field with a label, control, and optional hint. */
    function Field({ id, label, hint, children }) {
      return h('div', { className: 'dbg-field' },
        h('label', { className: 'dbg-fieldLabel', htmlFor: id }, label),
        h('div', { className: 'dbg-fieldBody' },
          children,
          hint === undefined ? null : h('p', { className: 'dbg-hint' }, hint)))
    }

    /** Row configuration page body: every field is a native volatile setting. */
    function GoalConfigPage({ form, t }) {
      const state = form?.state
      const revision = state?.revision
      const host = state?.status === 'ready' ? shapeConfig(state.value) : null
      const baseDraft = host === null ? null : toDraft(host)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const live = draft !== null && draft.revision === revision ? draft.value : baseDraft
      const parsed = live === null ? null : parseDraft(live, host)
      const invalid = parsed?.error ?? null
      const writable = state?.status === 'ready' && state?.writable === true
      const dirty = host !== null && parsed?.value !== undefined && !sameConfig(host, parsed.value)

      const edit = useCallback((mutate) => {
        setNotice(null)
        setDraft((previous) => {
          const base = previous !== null && previous.revision === revision ? previous.value : baseDraft
          return base === null ? previous : { revision, value: mutate(base) }
        })
      }, [baseDraft, revision])

      const save = useCallback(async () => {
        if (!form || !writable || busy || !dirty || invalid !== null || parsed?.value === undefined) return
        const ops = diffOps(host, parsed.value)
        if (ops.length === 0) return
        setBusy(true)
        setNotice(null)
        try {
          const accepted = await form.mutate(ops, revision)
          if (accepted) {
            // Keep the draft; the mirrored revision folds it away.
            setNotice({ tone: 'ok', text: tr(t, 'saved') })
          } else {
            setDraft(null)
            setNotice({ tone: 'warn', text: tr(t, 'conflict') })
          }
        } catch (error) {
          setNotice({ tone: 'error', text: tr(t, 'saveFailed') + String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }, [busy, dirty, form, host, invalid, parsed, revision, t, writable])

      if (state === undefined) {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note dbg-pulse', role: 'status' }, tr(t, 'waitingForm')),
          h('p', { className: 'dbg-hint' }, tr(t, 'noFormHint')))
      }
      if (state.status === 'loading') {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note dbg-pulse', role: 'status' }, tr(t, 'loading')))
      }
      if (host === null) {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note', 'data-tone': 'warn' }, tr(t, 'unavailable')),
          h('p', { className: 'dbg-hint' }, tr(t, 'noFormHint')))
      }

      const roundLimitValue = parsePositiveSafeIntegerText(live.roundLimit)
      const timeoutValue = parseQuestionTimeoutText(live.questionTimeoutSeconds)
      const status = notice !== null
        ? h('span', { className: 'dbg-status', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
        : invalid !== null
          ? h('span', { className: 'dbg-status', 'data-tone': 'error', role: 'alert' }, tr(t, invalid))
          : h('span', { className: 'dbg-status', role: 'status' }, writable ? '' : tr(t, 'readonlyNote'))

      return h('div', { className: 'dbg-cfg' },
        h('div', { className: 'dbg-sectionHead' },
          h('h3', { className: 'dbg-title' }, tr(t, 'settingsTitle')),
          h('p', { className: 'dbg-intro' }, tr(t, 'settingsIntro'))),
        writable ? null : h('p', { className: 'dbg-note', 'data-tone': 'warn' }, tr(t, 'readonly')),
        h('div', { className: 'dbg-section' },
          h(Field, {
            id: 'dsh-better-goal-round-limit-mode',
            label: tr(t, 'modeLabel'),
            hint: live.roundLimitMode === 'agent'
              ? tr(t, 'modeAgentHint')
              : live.roundLimitMode === 'unlimited'
                ? tr(t, 'modeUnlimitedHint')
                : tr(t, 'modeFixedHint'),
          },
          h('select', {
            className: 'dbg-select',
            id: 'dsh-better-goal-round-limit-mode',
            value: live.roundLimitMode,
            disabled: !writable || busy,
            onChange: (event) => edit((current) => ({ ...current, roundLimitMode: event.target.value })),
          },
          h('option', { value: 'agent' }, tr(t, 'modeAgent')),
          h('option', { value: 'unlimited' }, tr(t, 'modeUnlimited')),
          h('option', { value: 'fixed' }, tr(t, 'modeFixed')))),
          live.roundLimitMode === 'fixed'
            ? h(Field, {
              id: 'dsh-better-goal-round-limit',
              label: tr(t, 'roundLimitLabel'),
              hint: roundLimitValue === UNLIMITED_ROUNDS
                ? `${tr(t, 'roundLimitHint')} ${tr(t, 'roundLimitUnlimited')}`
                : tr(t, 'roundLimitHint'),
            },
            h('input', {
              className: 'dbg-input',
              id: 'dsh-better-goal-round-limit',
              type: 'number',
              min: 1,
              max: UNLIMITED_ROUNDS,
              step: 1,
              inputMode: 'numeric',
              value: live.roundLimit,
              disabled: !writable || busy,
              'aria-invalid': invalid === 'invalidRoundLimit' ? true : undefined,
              onChange: (event) => edit((current) => ({ ...current, roundLimit: event.target.value })),
            }))
            : null,
          h(Field, {
            id: 'dsh-better-goal-question-timeout',
            label: tr(t, 'questionTimeoutLabel'),
            hint: timeoutValue === -1
              ? `${tr(t, 'questionTimeoutHint')} ${tr(t, 'questionTimeoutNever')}`
              : tr(t, 'questionTimeoutHint'),
          },
          h('input', {
            className: 'dbg-input',
            id: 'dsh-better-goal-question-timeout',
            type: 'number',
            min: -1,
            max: MAX_QUESTION_TIMEOUT_SECONDS,
            step: 1,
            inputMode: 'numeric',
            value: live.questionTimeoutSeconds,
            disabled: !writable || busy,
            'aria-invalid': invalid === 'invalidQuestionTimeout' ? true : undefined,
            onChange: (event) => edit((current) => ({ ...current, questionTimeoutSeconds: event.target.value })),
          }))),
        h('div', { className: 'dbg-footer' },
          h('button', {
            type: 'button',
            className: 'dbg-button',
            'data-variant': 'primary',
            disabled: !writable || busy || !dirty || invalid !== null,
            onClick: () => void save(),
          }, busy ? tr(t, 'saving') : tr(t, 'save')),
          h('button', {
            type: 'button',
            className: 'dbg-button',
            'data-variant': 'outline',
            disabled: busy || draft === null,
            onClick: () => {
              setDraft(null)
              setNotice(null)
            },
          }, tr(t, 'reset')),
          status))
    }

    /** `plugins.row.config` entry: summary in the row list, page body otherwise. */
    function GoalConfigPanel(props) {
      const t = props.t ?? fallbackT
      if (props.view === 'summary') return h('span', null, tr(t, 'summary'))
      return h('div', null,
        h('style', { 'data-plugin-css': STYLE_SETTINGS }, SETTINGS_CSS),
        h(GoalConfigPage, { form: props.form, t }))
    }

    /**
     * The one slot entry component registered under every row-config key.
     * Sharing this identity guarantees both assemblies render the same page
     * over the same host-supplied form instead of diverging copies.
     */
    function GoalConfigEntry(props) {
      return h(GoalConfigPanel, { ...props, t: props.t ?? fallbackT })
    }

    // ── Plugin body ────────────────────────────────────────────────────────

    /** Services this client half consumes. */
    const inject = ['slots', 'sessions', 'remote', 'remote.goals', 'locale']

    /** Register the GoalBar dock and the row configuration page. */
    function apply(ctx) {
      let disposeDictionaries = () => {}
      try {
        disposeDictionaries = ctx.locale.register(NS, { zh, en })
        fallbackT = ctx.locale.bind(NS)
      } catch (error) {
        // Locale is optional for rendering; keep the built-in Chinese dictionary.
        console.warn('[dsh-better-goal] locale registration failed:', error)
      }
      ctx.effect(() => disposeDictionaries, 'dsh-better-goal: dictionaries')

      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-better-goal',
        order: 10,
        locale: NS,
        inject: (sessionId) => createGoalDockFace(ctx, sessionId),
      }, (props) => h(GoalDock, { ...props, t: props.t ?? fallbackT }))), 'dsh-better-goal: GoalBar')

      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => {
        const disposers = []
        try {
          for (const key of ROW_CONFIG_KEYS) {
            disposers.push(ctx.slots.register({
              name: 'plugins.row.config',
              key,
              locale: NS,
            }, GoalConfigEntry))
          }
        } catch (error) {
          console.warn('[dsh-better-goal] row config page unavailable:', error)
        }
        return () => {
          for (const dispose of disposers) dispose()
        }
      }), 'dsh-better-goal: row config page')
    }

    exports.inject = inject
    exports.apply = apply
    // Exported for the scoped React tests; production uses apply().
    exports.GoalBar = GoalBar
    exports.GoalDock = GoalDock
    exports.GoalConfigPanel = GoalConfigPanel
    exports.GoalConfigPage = GoalConfigPage
    exports.createGoalActions = createGoalActions
    exports.shapeConfig = shapeConfig
    exports.parseDraft = parseDraft
    exports.diffOps = diffOps
    return module.exports
  },
})
