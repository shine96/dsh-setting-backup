import { registerRoutes } from './routes.js';

export const name = 'dsh-setting-backup';

export function apply(ctx, config = {}) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => registerRoutes(hostCtx, ctx, config),
      'dsh-setting-backup: routes',
    );
  });
}
