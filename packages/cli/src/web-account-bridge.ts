import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createSharedZCodeCredentialStore,
  SHARED_ZCODE_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";

/**
 * Lets the CLI use accounts that were signed in through zh web.
 *
 * Web and CLI share credentials.json, and the cached Coding Plan api-key is already stored
 * under the key the CLI looks for. The only thing missing for the CLI is the
 * `account-provider:<providerId>:identity` pointer, which only `zh login` writes. Web keeps the
 * identity in the oauth user profile, so this wrapper answers that one key from the profile when
 * web's own settings say the family is connected (individual coding plan, or any plan for Start Plan).
 *
 * Read-only: no writes, no refresh, no network; a profile that cannot be read is treated as absent
 * (unlike the web repo, which clears the oauth session on a decrypt error).
 */
const FAMILIES = {
  zai: SHARED_ZCODE_CREDENTIAL_KEYS.zaiUserInfo,
  bigmodel: SHARED_ZCODE_CREDENTIAL_KEYS.bigmodelUserInfo,
} as const;
type Family = keyof typeof FAMILIES;

const IDENTITY_KEY =
  /^account-provider:(account:(zai|bigmodel)-(individual-coding-plan|start-plan)):identity$/;

export function createWebBridgedCredentialStore(
  env: Record<string, string | undefined>,
): SharedZCodeCredentialStore {
  const store = createSharedZCodeCredentialStore({ env });

  const webConnected = async (family: Family, plan: string): Promise<boolean> => {
    try {
      const settings = JSON.parse(await readFile(join(dirname(store.filePath), "setting.json"), "utf8"));
      return (
        settings.providerFamilyDomain === family &&
        // Start Plan needs only the connected family (same as web's resolveCurrentAccountAccess).
        (plan === "start-plan" ||
          settings.providerFamilyConnectionSelections?.[family]?.kind === plan)
      );
    } catch {
      return false;
    }
  };

  const webIdentity = async (key: string): Promise<string | null> => {
    const match = IDENTITY_KEY.exec(key);
    const family = match?.[2] as Family | undefined;
    if (!family || !(await webConnected(family, match![3]!))) return null;
    try {
      const raw = await store.load(FAMILIES[family]);
      const profile = raw ? JSON.parse(raw) : {};
      // Same mapping as the web oauth repo: zai stores the backend user as-is (user_id).
      const id = profile.id ?? (family === "zai" ? profile.user_id : undefined);
      return typeof id === "string" && id.trim() ? id.trim() : null;
    } catch {
      return null;
    }
  };

  const load = async (key: string) => (await store.load(key)) ?? (await webIdentity(key));
  return {
    ...store,
    load,
    async loadMany(keys) {
      const found = await store.loadMany(keys);
      return Object.fromEntries(
        await Promise.all(keys.map(async (key) => [key, found[key] ?? (await webIdentity(key))] as const)),
      );
    },
  };
}
