/** Configure the independent plugin's native settings-page policy. */
export function mountSettings(ctx) {
  ctx.inject(['settings'], (inner) => {
    const dispose = inner.settings.configure({ auto: false }, ctx.fiber)
    inner.effect(() => dispose, 'better-goal: settings page')
  })
}
