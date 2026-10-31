// Globals the type-checked scripts (// @ts-check) use that tsc cannot infer from js/*.js.
// Everything else comes from the scripts listed in jsconfig.json "files".
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database as GeneratedDatabase, Json } from "./db";

type PublicSchema = GeneratedDatabase["public"];

// RPCs that return jsonb are built with jsonb_build_object in SQL, so Postgres has no shape for
// them and the generator emits `Json`. Treat those results as `any`; names and Args stay checked.
type LooseJsonReturns<F> = {
  [K in keyof F]: F[K] extends { Args: infer A; Returns: infer R }
    ? { Args: A; Returns: Json extends R ? any : R }
    : F[K];
};

type AppDatabase = {
  public: Omit<PublicSchema, "Functions"> & { Functions: LooseJsonReturns<PublicSchema["Functions"]> };
};

type AppSupabaseClient = SupabaseClient<AppDatabase>;

declare global {
  /** Set by js/supabase.js once config loads. Typed against types/db.d.ts. */
  var supabaseClient: AppSupabaseClient;
  interface Window {
    supabaseClient: AppSupabaseClient;
    configPromise: Promise<boolean> | null;
    PdfPreview: any;
    SINGLE_DATE_FILTER_RANGE: Set<string>;
    RECORD_DATE_KEYS: Record<string, string>;
    APP_REQUEST_TIMEOUT_MS: number;
    ActionProgress: any;
    AppLoader: any;
    AppError: any;
  }

  // Assigned to window inside IIFEs, which tsc cannot follow. Loosely typed until their
  // defining scripts are checked too.
  var AppError: any;
  var AppDialog: any;
  var PumpSettings: any;
  var loadPumpSettings: (...args: any[]) => Promise<any>;
  var PrintUtils: any;
  var initPageSections: (...args: any[]) => any;
}
