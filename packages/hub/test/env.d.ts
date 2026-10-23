import type { Env as HubEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends HubEnv {}
  }
}
