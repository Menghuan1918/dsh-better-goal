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
      useDeferredValue,
      useRef,
      useState,
    } = React

    /** Locale namespace owned by this closure. */
    const NS = 'better-goal'
    /** Must stay in sync with src/config.js. */
    const ROW_KEY = 'dsh-better-goal#dsh-better-goal'
    /**
     * Apollo's bundle patch re-declares the same top-level row. The Plugins page
     * keys a row's configuration by its declaring bundle and row id, so an
     * Apollo-only assembly looks the page up as `<apollo package>#dsh-better-goal`.
     * The unscoped name is kept for historical assemblies; the published package
     * is scoped. Registering the same page under every exact key keeps the
     * independent plugin's config namespace and store unchanged in any assembly.
     */
    const APOLLO_ROW_KEY = 'dsh-apollo#dsh-better-goal'
    /** Apollo's published scoped package name declares the same row. */
    const SCOPED_APOLLO_ROW_KEY = '@menghuan1918/dsh-apollo#dsh-better-goal'
    /** Every assembly's `plugins.row.config` key, in dispatch order. */
    const ROW_CONFIG_KEYS = Object.freeze([ROW_KEY, APOLLO_ROW_KEY, SCOPED_APOLLO_ROW_KEY])
    const ROUND_LIMIT_MODES = Object.freeze(['agent', 'unlimited', 'fixed'])
    const DEFAULT_ROUND_LIMIT = 256
    const UNLIMITED_ROUNDS = Number.MAX_SAFE_INTEGER
    const STYLE_GOAL = 'dsh-better-goal/goal.css'
    const STYLE_SETTINGS = 'dsh-better-goal/settings.css'

    // ── Copy ────────────────────────────────────────────────────────────────

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      summary: '目标与自动续跑',
      waitingForm: '正在加载设置…',
      noFormHint: '请检查插件的设置服务是否已加载，并使用受信任的连接。',
      loading: '正在读取配置…',
      unavailable: '当前连接无法访问设置。',
      readonly: '此连接只能查看设置。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      conflict: '配置已被更新，已重新读取。请检查后重试。',
      saveFailed: '保存失败：',
      reset: '放弃改动',
      modeLabel: '轮数策略',
      modeAgent: '由 Agent 决定',
      modeAgentHint: '可由 Agent 设置；未设置时不限轮数。',
      modeUnlimited: '无上限',
      modeUnlimitedHint: '持续推进，直到完成或暂停。',
      modeFixed: '固定轮数',
      modeFixedHint: '每个目标最多运行指定轮数。',
      roundLimitLabel: '轮数上限',
      roundLimitHint: '达到上限后停止续跑。',
      roundLimitUnlimited: '当前值等于兼容哨兵，界面显示为无上限。',
      questionTimeoutLabel: '目标提问超时（秒）',
      questionTimeoutHint: '-1 表示永不超时；否则为 1 到 2147483 的整数。热设置只影响新发起的等待，不改变当前等待。',
      questionTimeoutNever: '当前设置：永不超时。',
      invalidMode: '请选择一种轮数上限策略。',
      invalidRoundLimit: '固定轮数必须是 1 到 9007199254740991 之间的正整数。',
      invalidQuestionTimeout: '提问超时必须是 -1，或 1 到 2147483 之间的整数。',
      readonlyNote: '只读：当前无法写入宿主配置。',
      unavailableNote: '不可写：当前连接下该配置不可用。',
      settingsTitle: '目标',
      settingsIntro: '',
      'phase.active': '进行中',
      'phase.active.disarmed': '已暂停',
      'phase.paused': '已暂停',
      'phase.blocked': '受阻',
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
      nativeSection: '原生策略',
      nativeDefaultLabel: '默认轮数上限',
      nativeDefaultHint: '新目标未指定上限时使用；已有目标保持原值。',
      nativeBlockedLabel: '报告受阻门槛',
      nativeBlockedHint: 'Agent 执行到此轮数后可报告受阻。',
      invalidImplementation: '请选择目标实现。',
      invalidNative: '原生参数必须是正安全整数。',
      help: '了解设置',
      implementation: '目标实现',
      replaceNative: '替换原生 Goal',
      enhancedDescription: '接管原生目标，支持灵活的轮数策略。',
      nativeDescription: '使用宿主原生目标与轮数规则。',
      unsaved: '未保存的改动',
      restartAfterSave: '保存后需重启 profile',
      editShortcut: '⌘ / Ctrl + Enter 保存 · Esc 取消',
      replaceHint: '关闭后由宿主原生 Goal 管理目标与续跑。保存后重启当前 profile。',
      reloadRequired: '重启 profile 后生效',
      runtimeBetter: '增强',
      runtimeNative: '原生',
      runtimeLoading: '正在检查运行状态…',
      runtimeUnavailable: '无法读取运行状态。',
      nativeDependency: '原生模式使用宿主的轮数策略。',
      runtimeActive: '当前运行：{implementation}',
      roundsSection: '自动续跑',
      legacySection: '兼容配置',
      legacyHint: '旧版提问超时仅为迁移保留。提问等待请在提问插件中设置。',
      legacyTimeout: '原提问等待：{seconds} 秒',
      never: '永不超时',
      'action.details': '展开目标',
      'action.history': '目标历史',
      'action.hideHistory': '收起历史',
      'phase.complete': '已完成',
      'phase.cleared': '已清除',
      'phase.archived': '已替换',
      'history.title': '目标历史',
      'history.search': '搜索目标',
      'history.all': '全部状态',
      'history.empty': '没有匹配的目标',
      'history.rounds': '{rounds} / {max} 轮',
      'history.count': '{count} 个目标',
      'history.updated': '更新于 {time}',
      'history.error': '目标历史读取失败',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      summary: 'Goals and continuation',
      waitingForm: 'Loading settings…',
      noFormHint: 'Check that the plugin settings service is loaded and use a trusted connection.',
      loading: 'Loading configuration…',
      unavailable: 'Settings are unavailable on this connection.',
      readonly: 'Settings are read-only on this connection.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      conflict: 'Settings changed elsewhere and were reloaded. Review and try again.',
      saveFailed: 'Save failed: ',
      reset: 'Discard',
      modeLabel: 'Round policy',
      modeAgent: 'Agent decides',
      modeAgentHint: 'The agent can set a cap; defaults to unlimited.',
      modeUnlimited: 'Unlimited',
      modeUnlimitedHint: 'Continue until complete or paused.',
      modeFixed: 'Fixed rounds',
      modeFixedHint: 'Limit each goal to a fixed number of rounds.',
      roundLimitLabel: 'Round limit',
      roundLimitHint: 'Automatic continuation stops at the limit.',
      roundLimitUnlimited: 'This value is the compatibility sentinel; the UI renders it as unlimited.',
      questionTimeoutLabel: 'Goal-question timeout (seconds)',
      questionTimeoutHint: '-1 never times out; otherwise an integer from 1 to 2147483. Hot changes affect only newly started waits, never the current one.',
      questionTimeoutNever: 'Current setting: never times out.',
      invalidMode: 'Choose a round-cap policy.',
      invalidRoundLimit: 'The fixed cap must be a positive integer from 1 to 9007199254740991.',
      invalidQuestionTimeout: 'The timeout must be -1 or an integer from 1 to 2147483.',
      readonlyNote: 'Read-only: host configuration cannot be written.',
      unavailableNote: 'Not writable: this configuration is unavailable on the current connection.',
      settingsTitle: 'Goals',
      settingsIntro: '',
      'phase.active': 'Running',
      'phase.active.disarmed': 'Paused',
      'phase.paused': 'Paused',
      'phase.blocked': 'Blocked',
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
      nativeSection: 'Native policy',
      nativeDefaultLabel: 'Default round cap',
      nativeDefaultHint: 'Used when a new goal omits its cap. Existing goals keep theirs.',
      nativeBlockedLabel: 'Minimum rounds to report blocked',
      nativeBlockedHint: 'The agent can report blocked after this many admitted rounds.',
      invalidImplementation: 'Choose a goal implementation.',
      invalidNative: 'Native parameters must be positive safe integers.',
      help: 'About these settings',
      implementation: 'Implementation',
      replaceNative: 'Replace native Goal',
      enhancedDescription: 'Replaces native goals with flexible round policies.',
      nativeDescription: 'Uses the host’s native goals and round rules.',
      unsaved: 'Unsaved changes',
      restartAfterSave: 'Save, then restart the profile',
      editShortcut: '⌘ / Ctrl + Enter to save · Esc to cancel',
      replaceHint: 'When off, the host’s native Goal manages goals and continuation. Save, then restart the profile.',
      reloadRequired: 'Restart the profile to apply',
      runtimeBetter: 'Enhanced',
      runtimeNative: 'Native',
      runtimeLoading: 'Checking runtime…',
      runtimeUnavailable: 'Runtime status unavailable.',
      nativeDependency: 'Native mode uses the host’s round policy.',
      runtimeActive: 'Running: {implementation}',
      roundsSection: 'Continuation',
      legacySection: 'Compatibility',
      legacyHint: 'The old question timeout is retained for migration. Configure question waits in the question plugin.',
      legacyTimeout: 'Previous question wait: {seconds} s',
      never: 'Never',
      'action.details': 'Expand goal',
      'action.history': 'Goal history',
      'action.hideHistory': 'Hide history',
      'phase.complete': 'Complete',
      'phase.cleared': 'Cleared',
      'phase.archived': 'Replaced',
      'history.title': 'Goal history',
      'history.search': 'Search goals',
      'history.all': 'All states',
      'history.empty': 'No matching goals',
      'history.rounds': '{rounds} / {max} rounds',
      'history.count': '{count} goals',
      'history.updated': 'Updated {time}',
      'history.error': 'Goal history could not be read',
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

    // Scoped neutral surfaces follow the host in light and dark themes.
    const GOAL_CSS = `.dbg-dock{--dbg-accent:#3388BB;--dbg-on-accent:#fff;--dbg-selected:color-mix(in srgb,var(--dbg-accent) 72%,var(--dsw-alias-label-primary));box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,12px) - 4 * var(--dsh-composer-dock-inset,2px));max-width:var(--dsh-composer-card-max-width,820px);margin:0 auto;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;container-type:inline-size;container-name:better-goal-dock}
.dbg-bar{box-sizing:border-box;min-height:40px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;gap:10px;padding:4px 5px 4px 12px;position:relative;overflow:hidden}
.dbg-bar[data-expanded=true]{border-radius:12px 12px 0 0}
.dbg-goalMain{flex:1;min-width:0;display:flex;align-items:center;gap:10px}
.dbg-goalStatus{display:flex;align-items:center;gap:8px;flex:none}
.dbg-goalGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex}
.dbg-bar[data-running=true] :is(.dbg-goalGlyph,.dbg-label){color:var(--dbg-selected)}
.dbg-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
.dbg-objective{display:flex;align-items:center;gap:8px;min-width:0;min-height:28px;flex:1;text-align:left;color:var(--dsw-alias-label-secondary);font:inherit;background:transparent;border:0;border-radius:6px;padding:0;cursor:pointer}
.dbg-objectiveText{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dbg-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary);transition:transform 100ms ease}
[aria-expanded=true]>.dbg-chevron,.dbg-historyList details[open]>summary>.dbg-chevron{transform:rotate(180deg)}
.dbg-meta,.dbg-historyMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dbg-meta{margin-left:auto}
.dbg-error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dbg-editBar{display:block;padding:12px}
.dbg-editLabel{display:block;margin-bottom:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dbg-editInput{box-sizing:border-box;resize:vertical;width:100%;min-height:88px;max-height:280px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;line-height:20px}
.dbg-editFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap}
.dbg-editHint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-right:auto}
.dbg-actions{flex:none;align-items:center;gap:4px;display:flex}
.dbg-iconBtn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:transparent;border:0;border-radius:50%;justify-content:center;align-items:center;padding:0;display:inline-flex;transition:background-color 100ms ease}
.dbg-editButton{height:32px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:inherit;padding:0 12px;font:inherit;font-size:13px;cursor:pointer}
.dbg-editButton[data-primary=true]{background:color-mix(in srgb,var(--dbg-accent) 85%,black);color:var(--dbg-on-accent);border-color:transparent}
.dbg-iconBtn:hover:not(:disabled),.dbg-objective:hover,.dbg-historyList summary:hover,.dbg-editButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dbg-editButton[data-primary=true]:hover:not(:disabled){background:color-mix(in srgb,var(--dbg-accent) 72%,black)}
.dbg-iconBtn[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dbg-iconBtn:active:not(:disabled),.dbg-objective:active,.dbg-editButton:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dbg-editButton[data-primary=true]:active:not(:disabled){background:color-mix(in srgb,var(--dbg-accent) 72%,black)}
.dbg-iconBtn[data-danger=true]:hover{color:var(--dsw-alias-state-error-primary)}
.dbg-dock :disabled{opacity:.4;cursor:default}
.dbg-dock :is(button,input,textarea,select,summary):focus{outline:none}
.dbg-dock :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--dbg-accent);outline-offset:2px}
.dbg-progressTrack{position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--dsw-alias-border-l2);pointer-events:none}
.dbg-progress{display:block;height:100%;background:var(--dbg-accent)}
.dbg-details,.dbg-history{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:12px}
.dbg-details{border-top:0;border-radius:0 0 12px 12px}
.dbg-history{margin-top:8px}
.dbg-fullObjective{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;line-height:20px}
.dbg-historyHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:14px;font-weight:500}
.dbg-historyTools{display:flex;gap:8px;margin-bottom:12px}
.dbg-search,.dbg-filter{box-sizing:border-box;min-width:0;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-layer-1);font:inherit}
.dbg-search{flex:1;width:100%}
.dbg-search:hover,.dbg-filter:hover,.dbg-editInput:hover{border-color:var(--dsw-alias-border-l3)}
.dbg-historyList{list-style:none;padding:0;margin:0;max-height:320px;overflow:auto;scrollbar-width:thin;scrollbar-gutter:stable}
.dbg-historyList>li{content-visibility:auto;contain-intrinsic-size:auto 60px}
.dbg-historyList>li+li{border-top:1px solid var(--dsw-alias-border-l2)}
.dbg-historyList summary{cursor:pointer;display:flex;align-items:center;gap:12px;min-height:48px;padding:8px;list-style:none;border-radius:6px}
.dbg-historyList summary::-webkit-details-marker{display:none}
.dbg-historyIdentity{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dbg-historyName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:500}
.dbg-historyFacts{display:flex;align-items:center;gap:12px}
.dbg-historyBody{padding:0 8px 16px 16px;border-left:1px solid var(--dsw-alias-border-l2);margin:0 8px 8px}
.dbg-historyBody time{display:block;margin-top:12px}
.dbg-historyState{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dbg-historyList li[data-phase=active] .dbg-historyState{color:var(--dbg-selected)}
.dbg-historyEmpty{padding:24px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
@container better-goal-dock (max-width:540px){.dbg-bar{flex-wrap:wrap;gap:4px 8px}.dbg-goalMain{flex-basis:100%}.dbg-actions{margin-left:auto}.dbg-historyTools{flex-wrap:wrap}.dbg-filter{flex:1}.dbg-editHint{flex-basis:100%}}
@container better-goal-dock (max-width:360px){.dbg-goalMain{align-items:stretch;flex-direction:column;gap:0}.dbg-goalStatus{flex-wrap:wrap}.dbg-historyFacts{gap:8px;flex-wrap:wrap}}
@media(pointer:coarse),(max-width:540px){.dbg-iconBtn,.dbg-editButton{min-width:44px;min-height:44px}.dbg-objective{min-height:44px}}
@media(prefers-reduced-motion:reduce){.dbg-dock *{animation:none!important;transition:none!important}}`

    const SETTINGS_CSS = `.dbg-cfg{--cfg-accent:#3388BB;--cfg-on-accent:#fff;--cfg-selected:color-mix(in srgb,var(--cfg-accent) 72%,var(--dsw-alias-label-primary));display:flex;flex-direction:column;gap:24px;max-width:960px;min-width:0;font-size:13px;line-height:20px;container-type:inline-size;container-name:better-goal-settings;color:var(--dsw-alias-label-primary)}
.dbg-note{margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dbg-note[data-tone=error],.dbg-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dbg-note[data-tone=warn]{border-left:2px solid var(--dsw-alias-state-warn-primary)}
.dbg-section{display:flex;flex-direction:column;gap:16px;border:0;border-top:1px solid var(--dsw-alias-border-l2);padding:24px 0 0;margin:0;min-width:0}
.dbg-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dbg-title{margin:0;font-size:18px;font-weight:500;line-height:26px}
.dbg-sectionTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}
.dbg-section legend{float:left;width:100%;padding:0;margin:0}
.dbg-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dbg-field{display:grid;grid-template-columns:minmax(160px,1fr) minmax(0,280px);gap:8px 24px;align-items:start}
.dbg-fieldHeading{display:flex;flex-direction:column;gap:4px;min-width:0;padding-top:7px}
.dbg-fieldLabel{font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dbg-fieldBody{display:flex;flex-direction:column;gap:4px;min-width:0}
.dbg-input{box-sizing:border-box;width:100%;min-width:0;height:32px;padding:0 10px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;transition:border-color 100ms ease;font-variant-numeric:tabular-nums}
.dbg-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dbg-cfg :is(input,button,summary):focus{outline:none}
.dbg-cfg :is(input,button,summary):focus-visible{outline:2px solid var(--cfg-accent);outline-offset:2px}
.dbg-cfg :disabled{opacity:.4;cursor:not-allowed}
.dbg-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dbg-implementationChoices{display:inline-flex;align-self:flex-start;max-width:100%;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.dbg-choice{position:relative;min-width:0;cursor:pointer;display:block;flex:1}
.dbg-choiceInput{position:absolute;width:1px;height:1px;opacity:0;margin:0}
.dbg-choiceFace{position:relative;display:flex;align-items:center;justify-content:center;border:0;border-radius:8px;padding:0 16px;min-height:28px;box-sizing:border-box;transition:background-color 100ms ease}
.dbg-choiceHeading{font-size:13px;line-height:20px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dbg-choiceInput:checked+.dbg-choiceFace{background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.dbg-choiceInput:checked+.dbg-choiceFace:after{content:"";position:absolute;bottom:0;left:12px;right:12px;height:2px;border-radius:2px;background:var(--cfg-accent)}
.dbg-choiceInput:checked+.dbg-choiceFace .dbg-choiceHeading{color:var(--dsw-alias-label-primary);font-weight:500}
.dbg-choice:hover .dbg-choiceInput:not(:disabled)+.dbg-choiceFace{background:var(--dsw-alias-interactive-bg-hover)}
.dbg-choice:active .dbg-choiceInput:not(:disabled)+.dbg-choiceFace{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dbg-choiceInput:focus-visible+.dbg-choiceFace,.dbg-segmentInput:focus-visible+span{outline:2px solid var(--cfg-accent);outline-offset:2px}
.dbg-choiceInput:disabled+.dbg-choiceFace{opacity:.4;cursor:not-allowed}
.dbg-runtime{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.dbg-runtimeCurrent{display:inline-flex;align-items:center;gap:8px}
.dbg-runtimeCurrent:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--cfg-accent)}
.dbg-runtimePending{padding-left:8px;border-left:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dbg-segmented{display:flex;align-self:flex-start;max-width:100%;padding:2px;gap:2px;background:var(--dsw-alias-bg-layer-2);border:0;border-radius:10px}
.dbg-segment{position:relative;flex:1;min-width:0;cursor:pointer;text-align:center}
.dbg-segmentInput{position:absolute;opacity:0;width:1px;height:1px;margin:0}
.dbg-segment>span{display:flex;align-items:center;justify-content:center;padding:0 12px;min-height:28px;border-radius:8px;font-size:13px;white-space:nowrap;color:var(--dsw-alias-label-secondary);transition:background-color 100ms ease}
.dbg-segmentInput:checked+span{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.dbg-segment:hover .dbg-segmentInput:not(:disabled)+span{background:var(--dsw-alias-interactive-bg-hover)}
.dbg-segment:active .dbg-segmentInput:not(:disabled)+span{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dbg-footer{display:flex;align-items:center;gap:8px;padding:16px 0;border-top:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap;position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-1)}
.dbg-footer>.dbg-button[data-variant=outline]{margin-left:auto}
.dbg-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:32px;padding:0 12px;border:.5px solid transparent;border-radius:6px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;transition:background-color 100ms ease}
.dbg-button[data-variant=primary]{background:color-mix(in srgb,var(--cfg-accent) 85%,black);color:var(--cfg-on-accent)}
.dbg-button[data-variant=primary]:hover:not(:disabled){background:color-mix(in srgb,var(--cfg-accent) 72%,black)}
.dbg-button[data-variant=outline]{border-color:var(--dsw-alias-border-l2)}
.dbg-button[data-variant=outline]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dbg-button:active:not(:disabled){filter:brightness(.94)}
.dbg-status{flex:1;min-width:120px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dbg-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.dbg-help{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dbg-help>summary{cursor:pointer;width:fit-content;padding:4px 0;list-style-position:inside}
.dbg-help>p{margin:8px 0;max-width:64ch}
@container better-goal-settings (max-width:540px){.dbg-field{grid-template-columns:minmax(0,1fr);gap:4px}.dbg-fieldHeading{padding-top:0}.dbg-status{flex-basis:100%;margin:4px 0 0}.dbg-runtimePending{padding-left:0;border:0;flex-basis:100%}.dbg-help>summary{min-height:32px;display:flex;align-items:center}.dbg-segment>span{padding:0 8px;white-space:normal}}
@media(prefers-reduced-motion:reduce){.dbg-cfg *{animation:none!important;transition:none!important}}`

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

    function IconInfo() {
      return iconSvg([
        h('circle', { key: 'circle', cx: 8, cy: 8, r: 5.5, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { key: 'stem', d: 'M8 7v4M8 4.8v.1', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      ])
    }

    function IconHistory() {
      return iconSvg([
        h('path', { key: 'arc', d: 'M2 7a6 6 0 1 1 1.4 5M2 3v4h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { key: 'clock', d: 'M8 4.5V8l2.5 1.5', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      ])
    }

    function IconChevron() {
      return iconSvg(h('path', { d: 'm4.5 6 3.5 3.5L11.5 6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))
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
    function IconButton({ label, disabled, onClick, expanded, danger, children }) {
      return h('button', {
        type: 'button',
        className: 'dbg-iconBtn',
        title: label,
        'aria-label': label,
        'aria-expanded': expanded,
        'data-danger': danger || undefined,
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
      onHistory,
      historyOpen,
      onEdit,
      onPause,
      onResume,
      onClear,
      t,
    }) {
      const [expanded, setExpanded] = useState(false)
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
        setExpanded(false)
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
            h('label', { className: 'dbg-editLabel', htmlFor: 'dsh-better-goal-objective' }, tr(t, 'objective.aria')),
            h('textarea', {
              id: 'dsh-better-goal-objective',
              className: 'dbg-editInput',
              rows: 3,
              value: draft,
              placeholder: tr(t, 'edit.placeholder'),
              'aria-label': tr(t, 'objective.aria'),
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  void handleEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  setEditing(false)
                }
              },
            }),
            actionError !== null ? h('span', { className: 'dbg-error', role: 'alert', title: actionError }, actionError) : null,
            h('div', { className: 'dbg-editFooter' },
              h('span', { className: 'dbg-editHint' }, tr(t, 'editShortcut')),
              h('button', { type: 'button', className: 'dbg-editButton', 'aria-label': tr(t, 'action.cancel'), disabled: pending, onClick: () => setEditing(false) }, tr(t, 'action.cancel')),
              h('button', { type: 'button', className: 'dbg-editButton', 'data-primary': true, 'aria-label': tr(t, 'action.save'), disabled: pending || draft.trim() === '', onClick: handleEdit }, tr(t, 'action.save'))),
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
        h('div', { className: 'dbg-bar', title, 'data-running': showPause, 'data-expanded': expanded, 'aria-busy': pending || undefined },
          h('div', { className: 'dbg-goalMain' },
            h('div', { className: 'dbg-goalStatus' },
              h('span', { className: 'dbg-goalGlyph' }, h(IconGoal)),
              h('span', { className: 'dbg-label' }, phaseLabel),
              rounds === undefined ? null : h('span', { className: 'dbg-meta' }, tr(t, 'meta.rounds', { rounds, max: capLabel }))),
            h('button', { type: 'button', className: 'dbg-objective', title: goal.objective, 'aria-label': tr(t, 'action.details'), 'aria-expanded': expanded, onClick: () => setExpanded((value) => !value) },
              h('span', { className: 'dbg-objectiveText' }, goal.objective), h('span', { className: 'dbg-chevron' }, h(IconChevron)))),
          h('div', { className: 'dbg-actions' },
            onHistory ? h(IconButton, { label: tr(t, 'action.history'), expanded: historyOpen, onClick: onHistory }, h(IconHistory)) : null,
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
              danger: true,
              disabled: pending,
              onClick: () => handleClear(goal.id),
            }, h(IconTrash))),
          rounds !== undefined && !isUnlimitedCap(goal.maxGoalRounds)
            ? h('div', { className: 'dbg-progressTrack', role: 'progressbar', 'aria-label': tr(t, 'roundLimitLabel'), 'aria-valuemin': 0, 'aria-valuemax': goal.maxGoalRounds, 'aria-valuenow': Math.min(rounds, goal.maxGoalRounds) }, h('span', { className: 'dbg-progress', style: { width: `${Math.min(100, rounds / goal.maxGoalRounds * 100)}%` } }))
            : null),
        actionError !== null ? h('p', { className: 'dbg-error', role: 'alert' }, actionError) : null,
        expanded ? h('div', { className: 'dbg-details' },
          h('p', { className: 'dbg-fullObjective' }, goal.objective),
          goal.blockedReason ? h('p', { className: 'dbg-error' }, goal.blockedReason.message) : null) : null)
    }

    /** Session history is a host-owned replay projection, never browser storage. */
    function GoalHistory({ history, currentGoalId, currentPhase, open, onToggle, showTrigger, t }) {
      const [query, setQuery] = useState('')
      const [phase, setPhase] = useState('all')
      const deferredQuery = useDeferredValue(query)
      const entries = history?.entries ?? []
      if (entries.length === 0 && !history?.error) return null
      const stateOf = (entry) => entry.cleared ? 'cleared' : entry.id === currentGoalId ? currentPhase ?? entry.phase : entry.phase !== 'complete' ? 'archived' : entry.phase
      const search = deferredQuery.trim().toLocaleLowerCase()
      const matching = open ? entries.filter((entry) => (phase === 'all' || stateOf(entry) === phase) && entry.objective.toLocaleLowerCase().includes(search)).toReversed() : []
      return h('div', { className: 'dbg-dock' },
        h('style', { 'data-plugin-css': STYLE_GOAL }, GOAL_CSS),
        showTrigger ? h('div', { className: 'dbg-bar' },
          h('span', { className: 'dbg-goalGlyph' }, h(IconHistory)),
          h('button', { type: 'button', className: 'dbg-objective', 'aria-label': tr(t, 'action.history'), 'aria-expanded': open, onClick: onToggle }, tr(t, 'history.title')),
          h('span', { className: 'dbg-meta' }, tr(t, 'history.count', { count: entries.length }))) : null,
        open ? h('section', { className: 'dbg-history', 'aria-label': tr(t, 'history.title') },
          h('div', { className: 'dbg-historyHead' },
            h('span', null, tr(t, 'history.title')),
            h(IconButton, { label: tr(t, 'action.hideHistory'), onClick: onToggle }, h(IconClose))),
          history?.error ? h('p', { role: 'alert', className: 'dbg-error' }, tr(t, 'history.error'), ': ', history.error) : null,
          h('div', { className: 'dbg-historyTools' },
            h('input', { type: 'search', className: 'dbg-search', value: query, placeholder: tr(t, 'history.search'), 'aria-label': tr(t, 'history.search'), onChange: (event) => setQuery(event.target.value) }),
            h('select', { className: 'dbg-filter', value: phase, 'aria-label': tr(t, 'history.all'), onChange: (event) => setPhase(event.target.value) },
              h('option', { value: 'all' }, tr(t, 'history.all')),
              ...['active', 'paused', 'blocked', 'complete', 'cleared', 'archived'].map((value) => h('option', { key: value, value }, tr(t, `phase.${value}`))))),
          matching.length === 0 ? h('div', { className: 'dbg-historyEmpty', role: 'status' }, tr(t, 'history.empty')) :
            h('ol', { className: 'dbg-historyList' }, matching.map((entry) => h('li', { key: entry.id, 'data-phase': stateOf(entry) },
              h('details', null,
                h('summary', null,
                  h('span', { className: 'dbg-historyIdentity' },
                    h('span', { className: 'dbg-historyName' }, entry.objective),
                    h('span', { className: 'dbg-historyFacts' },
                      h('span', { className: 'dbg-historyState' }, tr(t, `phase.${stateOf(entry)}`)),
                      h('span', { className: 'dbg-historyMeta' }, tr(t, 'history.rounds', { rounds: entry.roundsStarted, max: isUnlimitedCap(entry.maxGoalRounds) ? tr(t, 'cap.unlimited') : entry.maxGoalRounds })))),
                  h('span', { className: 'dbg-chevron' }, h(IconChevron))),
                h('div', { className: 'dbg-historyBody' },
                  h('p', { className: 'dbg-fullObjective' }, entry.objective),
                  entry.blockedReason ? h('p', { className: 'dbg-error' }, entry.blockedReason.message) : null,
                  h('time', { className: 'dbg-historyMeta', dateTime: new Date(entry.updatedAt).toISOString() }, tr(t, 'history.updated', { time: new Date(entry.updatedAt).toLocaleString() })))))))) : null)
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
      const [historyOpen, setHistoryOpen] = useState(false)
      const history = typeof useProjection === 'function' ? useProjection('better-goal-history') : undefined
      const projection = typeof useProjection === 'function' ? useProjection('goal') : undefined
      const goal = projection === undefined || projection === null ? projection : projection.goal
      const goalId = goal?.id
      const revision = goal?.revision
      const activation = typeof useGoalActivation === 'function'
        ? useGoalActivation((next) => next.id === goalId && next.revision === revision ? next.activation : undefined)
        : undefined
      const hasHistory = history?.entries?.length > 0 || history?.error
      const hasCurrent = goal && goal.phase !== 'complete'
      const toggleHistory = () => setHistoryOpen((value) => !value)
      return h(React.Fragment, null, h(GoalBar, {
        goal,
        onHistory: hasHistory ? toggleHistory : undefined,
        historyOpen,
        roundsStarted: projection === undefined || projection === null ? undefined : projection.roundsStarted,
        activation,
        onEdit,
        onPause,
        onResume,
        onClear,
        t,
      }), h(GoalHistory, { history, currentGoalId: goal?.id, currentPhase: goal?.phase === 'active' && activation === 'disarmed' ? 'paused' : goal?.phase, open: historyOpen, onToggle: toggleHistory, showTrigger: !hasCurrent, t }))
    }

    // ── Settings form (native row config) ──────────────────────────────────

    /** Normalize host values into the editable form shape, falling back to defaults. */
    function shapeConfig(value) {
      const source = isRecord(value) ? value : {}
      return {
        implementation: source.implementation === 'native' ? 'native' : 'enhanced',
        nativeDefaultMaxGoalRounds: isPositiveSafeInteger(source.nativeDefaultMaxGoalRounds) ? source.nativeDefaultMaxGoalRounds : 256,
        nativeBlockedAfterConsecutiveRounds: isPositiveSafeInteger(source.nativeBlockedAfterConsecutiveRounds) ? source.nativeBlockedAfterConsecutiveRounds : 3,
        roundLimitMode: ROUND_LIMIT_MODES.includes(source.roundLimitMode) ? source.roundLimitMode : 'agent',
        roundLimit: isPositiveSafeInteger(source.roundLimit) ? source.roundLimit : DEFAULT_ROUND_LIMIT,
      }
    }

    /** Host shape → raw text draft (empty/invalid text stays editable). */
    function toDraft(config) {
      return {
        implementation: config.implementation,
        nativeDefaultMaxGoalRounds: String(config.nativeDefaultMaxGoalRounds),
        nativeBlockedAfterConsecutiveRounds: String(config.nativeBlockedAfterConsecutiveRounds),
        roundLimitMode: config.roundLimitMode,
        roundLimit: String(config.roundLimit),
      }
    }

    function sameConfig(left, right) {
      return Object.keys(left).every((key) => left[key] === right[key])
    }

    function parsePositiveSafeIntegerText(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.trim()
      if (!/^[0-9]+$/.test(trimmed)) return undefined
      const value = Number(trimmed)
      return Number.isSafeInteger(value) && value >= 1 && value <= UNLIMITED_ROUNDS ? value : undefined
    }

    /**
     * Validate one text draft and produce the JSON value to write.
     * The hidden round-limit text is ignored outside `fixed` mode: the host
     * value stands, so switching modes never writes a value the user cannot see.
     */
    function parseDraft(draft, host) {
      if (!['native', 'enhanced'].includes(draft.implementation)) return { error: 'invalidImplementation' }
      if (!ROUND_LIMIT_MODES.includes(draft.roundLimitMode)) return { error: 'invalidMode' }
      let roundLimit = host.roundLimit
      if (draft.implementation === 'enhanced' && draft.roundLimitMode === 'fixed') {
        const parsed = parsePositiveSafeIntegerText(draft.roundLimit)
        if (parsed === undefined) return { error: 'invalidRoundLimit' }
        roundLimit = parsed
      }
      let nativeDefaultMaxGoalRounds = host.nativeDefaultMaxGoalRounds
      let nativeBlockedAfterConsecutiveRounds = host.nativeBlockedAfterConsecutiveRounds
      if (draft.implementation === 'native') {
        nativeDefaultMaxGoalRounds = parsePositiveSafeIntegerText(draft.nativeDefaultMaxGoalRounds)
        nativeBlockedAfterConsecutiveRounds = parsePositiveSafeIntegerText(draft.nativeBlockedAfterConsecutiveRounds)
        if (nativeDefaultMaxGoalRounds === undefined || nativeBlockedAfterConsecutiveRounds === undefined) return { error: 'invalidNative' }
      }
      return {
        value: {
          implementation: draft.implementation,
          nativeDefaultMaxGoalRounds,
          nativeBlockedAfterConsecutiveRounds,
          roundLimitMode: draft.roundLimitMode,
          roundLimit,
        },
      }
    }

    /** One atomic namespace mutation carrying only changed volatile fields. */
    function diffOps(host, next) {
      const ops = []
      for (const key of ['implementation', 'nativeDefaultMaxGoalRounds', 'nativeBlockedAfterConsecutiveRounds']) {
        if (host[key] !== next[key]) ops.push({ op: 'set', path: [key], value: next[key] })
      }
      if (host.roundLimitMode !== next.roundLimitMode) {
        ops.push({ op: 'set', path: ['roundLimitMode'], value: next.roundLimitMode })
      }
      if (host.roundLimit !== next.roundLimit) {
        ops.push({ op: 'set', path: ['roundLimit'], value: next.roundLimit })
      }
      return ops
    }

    /** A native label and concise description aligned with its control. */
    function Field({ id, label, hint, children }) {
      return h('div', { className: 'dbg-field' },
        h('div', { className: 'dbg-fieldHeading' },
          h('label', { className: 'dbg-fieldLabel', htmlFor: id }, label),
          hint === undefined ? null : h('p', { className: 'dbg-hint', id: id + '-hint' }, hint)),
        h('div', { className: 'dbg-fieldBody' }, children))
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
      const [runtime, setRuntime] = useState(undefined)
      const busyRef = useRef(false)
      useEffect(() => {
        let current = true
        fetch('/better-goal/api/config', { cache: 'no-store' })
          .then((response) => {
            if (!response.ok) throw new Error(String(response.status))
            return response.json()
          })
          .then((value) => { if (current) setRuntime(value) })
          .catch(() => { if (current) setRuntime(null) })
        return () => { current = false }
      }, [revision])

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
        if (!form || !writable || busyRef.current || !dirty || invalid !== null || parsed?.value === undefined) return
        const ops = diffOps(host, parsed.value)
        if (ops.length === 0) return
        busyRef.current = true
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
          busyRef.current = false
          setBusy(false)
        }
      }, [busy, dirty, form, host, invalid, parsed, revision, t, writable])

      if (state === undefined) {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note dbg-pulse', role: 'status' }, tr(t, 'waitingForm')),
          h('details', { className: 'dbg-help' }, h('summary', null, tr(t, 'help')), h('p', null, tr(t, 'noFormHint'))))
      }
      if (state.status === 'loading') {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note dbg-pulse', role: 'status' }, tr(t, 'loading')))
      }
      if (host === null) {
        return h('div', { className: 'dbg-cfg' },
          h('p', { className: 'dbg-note', 'data-tone': 'warn' }, tr(t, 'unavailable')),
          h('details', { className: 'dbg-help' }, h('summary', null, tr(t, 'help')), h('p', null, tr(t, 'noFormHint'))))
      }

      const roundLimitValue = parsePositiveSafeIntegerText(live.roundLimit)
      const status = notice !== null
        ? h('span', { className: 'dbg-status', 'data-tone': notice.tone, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
        : invalid !== null
          ? h('span', { className: 'dbg-status', 'data-tone': 'error', role: 'alert' }, tr(t, invalid))
          : h('span', { className: 'dbg-status', role: 'status' }, writable ? (dirty ? tr(t, 'unsaved') : '') : tr(t, 'readonlyNote'))

      const roundsDisabled = !writable || busy || live.implementation !== 'enhanced'
      const draftRequiresReload = parsed?.value && ['implementation', 'nativeDefaultMaxGoalRounds', 'nativeBlockedAfterConsecutiveRounds'].some((key) => parsed.value[key] !== host[key])
      const requiresReload = runtime?.requiresReload || (parsed?.value && ['implementation', 'nativeDefaultMaxGoalRounds', 'nativeBlockedAfterConsecutiveRounds'].some((key) => parsed.value[key] !== (runtime?.activeConfig ?? host)[key]))
      return h('div', { className: 'dbg-cfg', 'aria-busy': busy || undefined },
        h('div', { className: 'dbg-sectionHead' }, h('h3', { className: 'dbg-title' }, tr(t, 'settingsTitle'))),
        writable ? null : h('p', { className: 'dbg-note', 'data-tone': 'warn' }, tr(t, 'readonly')),
        h('section', { className: 'dbg-section', 'aria-label': tr(t, 'implementation') },
          h('h4', { className: 'dbg-sectionTitle' }, tr(t, 'implementation')),
          h('div', { className: 'dbg-implementationChoices', role: 'group', 'aria-label': tr(t, 'implementation'), 'aria-describedby': 'dsh-better-goal-implementation-hint' },
            ...['enhanced', 'native'].map((value) => h('label', { key: value, className: 'dbg-choice' },
              h('input', { className: 'dbg-choiceInput', type: 'radio', name: 'dsh-better-goal-implementation', id: 'dsh-better-goal-implementation-' + value, value,
                checked: live.implementation === value, disabled: !writable || busy,
                onChange: () => edit((current) => ({ ...current, implementation: value })) }),
              h('span', { className: 'dbg-choiceFace' },
                h('span', { className: 'dbg-choiceHeading' }, tr(t, value === 'enhanced' ? 'runtimeBetter' : 'runtimeNative')))))),
          h('p', { className: 'dbg-hint', id: 'dsh-better-goal-implementation-hint' }, tr(t, live.implementation === 'enhanced' ? 'enhancedDescription' : 'nativeDescription')),
          h('div', { className: 'dbg-runtime', role: 'status' },
            runtime?.runtime ? h('span', { className: 'dbg-runtimeCurrent' }, tr(t, 'runtimeActive', { implementation: tr(t, runtime.runtime.implementation === 'native' ? 'runtimeNative' : 'runtimeBetter') }))
              : h('span', null, tr(t, runtime === undefined ? 'runtimeLoading' : 'runtimeUnavailable')),
            requiresReload ? h('span', { className: 'dbg-runtimePending', 'data-restart-pending': true }, tr(t, draftRequiresReload && notice?.tone !== 'ok' ? 'restartAfterSave' : 'reloadRequired')) : null)),
        live.implementation === 'native' ? h('fieldset', { className: 'dbg-section', disabled: !writable || busy },
          h('legend', { className: 'dbg-sectionTitle' }, tr(t, 'nativeSection')),
          ...[
            ['nativeDefaultMaxGoalRounds', 'nativeDefaultLabel', 'nativeDefaultHint'],
            ['nativeBlockedAfterConsecutiveRounds', 'nativeBlockedLabel', 'nativeBlockedHint'],
          ].map(([key, label, hint]) => h(Field, { key, t, id: 'dsh-better-goal-' + key, label: tr(t, label), hint: tr(t, hint) },
            h('input', { className: 'dbg-input', id: 'dsh-better-goal-' + key, type: 'number', min: 1, max: UNLIMITED_ROUNDS, step: 1, inputMode: 'numeric', value: live[key], disabled: !writable || busy,
              'aria-describedby': 'dsh-better-goal-' + key + '-hint',
              'aria-invalid': invalid === 'invalidNative' || undefined,
              onChange: (event) => edit((current) => ({ ...current, [key]: event.target.value })),
            })))) : h('fieldset', { className: 'dbg-section', disabled: roundsDisabled },
          h('legend', { className: 'dbg-sectionTitle' }, tr(t, 'roundsSection')),
          h('div', { className: 'dbg-fieldBody' },
            h('div', { className: 'dbg-segmented', role: 'group', 'aria-label': tr(t, 'modeLabel'), 'aria-describedby': 'dsh-better-goal-mode-hint' },
              ...ROUND_LIMIT_MODES.map((value) => h('label', { className: 'dbg-segment', key: value },
                h('input', { className: 'dbg-segmentInput', type: 'radio', name: 'dsh-better-goal-round-limit-mode', id: 'dsh-better-goal-round-limit-mode-' + value, value,
                  checked: live.roundLimitMode === value, disabled: roundsDisabled,
                  onChange: () => edit((current) => ({ ...current, roundLimitMode: value })) }),
                h('span', null, tr(t, value === 'agent' ? 'modeAgent' : value === 'unlimited' ? 'modeUnlimited' : 'modeFixed'))))),
            h('p', { className: 'dbg-hint', id: 'dsh-better-goal-mode-hint' }, tr(t, live.roundLimitMode === 'agent' ? 'modeAgentHint' : live.roundLimitMode === 'unlimited' ? 'modeUnlimitedHint' : 'modeFixedHint'))),
          live.roundLimitMode === 'fixed'
            ? h(Field, { t, id: 'dsh-better-goal-round-limit', label: tr(t, 'roundLimitLabel'), hint: roundLimitValue === UNLIMITED_ROUNDS ? tr(t, 'roundLimitUnlimited') : tr(t, 'roundLimitHint') },
              h('input', { className: 'dbg-input', id: 'dsh-better-goal-round-limit', type: 'number', min: 1, max: UNLIMITED_ROUNDS, step: 1, inputMode: 'numeric', value: live.roundLimit, disabled: roundsDisabled,
                'aria-describedby': 'dsh-better-goal-round-limit-hint',
                'aria-invalid': invalid === 'invalidRoundLimit' || undefined,
                onChange: (event) => edit((current) => ({ ...current, roundLimit: event.target.value })),
              }))
            : null),
        state.value?.questionTimeoutSeconds !== undefined ? h('details', { className: 'dbg-help' },
          h('summary', null, tr(t, 'legacySection')),
          h('p', null, state.value.questionTimeoutSeconds === -1 ? tr(t, 'never') : tr(t, 'legacyTimeout', { seconds: state.value.questionTimeoutSeconds })),
          h('p', null, tr(t, 'legacyHint'))) : null,
        h('div', { className: 'dbg-footer' },
          status,
          h('button', { type: 'button', className: 'dbg-button', 'data-variant': 'outline', disabled: busy || draft === null, onClick: () => { setDraft(null); setNotice(null) } }, tr(t, 'reset')),
          h('button', { type: 'button', className: 'dbg-button', 'data-variant': 'primary', disabled: !writable || busy || !dirty || invalid !== null, onClick: () => void save() }, busy ? tr(t, 'saving') : tr(t, 'save'))))
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
    exports.GoalHistory = GoalHistory
    exports.GoalConfigPanel = GoalConfigPanel
    exports.GoalConfigPage = GoalConfigPage
    exports.createGoalActions = createGoalActions
    exports.shapeConfig = shapeConfig
    exports.parseDraft = parseDraft
    exports.diffOps = diffOps
    return module.exports
  },
})
