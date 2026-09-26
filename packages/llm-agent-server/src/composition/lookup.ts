import type {
  AnyCredential,
  CredentialEntry,
  CredentialFor,
} from './credential-for.js';

export type CredentialKind = AnyCredential['kind'];
type OfKind<K extends CredentialKind> = Extract<AnyCredential, { kind: K }>;

export interface ResolvedRef {
  /** A target that cannot work without one. */
  require<K extends CredentialKind>(kind: K): OfKind<K>;
  /** A target that can work without one — but only when none was asked for. */
  optional<K extends CredentialKind>(kind: K): { credential?: OfKind<K> };
  requireApiBaseUrl(): string;
  /** A target that sends nothing: naming a ref for it is a mistake worth reporting. */
  refuseAny(): void;
}

export type Lookup = (
  ref: string | undefined,
  roleDefault: string,
  target: string,
) => ResolvedRef;

/**
 * The lookup that makes "optional" mean what it says (§4.6.4): a ref may be
 * OMITTED, but a ref that was NAMED must resolve and hold the right kind — the
 * difference between a deployment that chose anonymous access and one with a
 * typo in it. The role default is read only when a target asks for a
 * credential (§8 item 4), so a target that takes none (an in-memory store, an
 * Ollama embedder) never parses the default entry.
 */
export function createLookup(credentialFor: CredentialFor): Lookup {
  return (ref, roleDefault, target) => {
    const named = ref !== undefined;
    const key = ref ?? roleDefault;
    const namedEntry = named ? credentialFor(key) : undefined;
    if (named && !namedEntry) {
      throw new Error(
        `credentialRef '${key}' for ${target} has no entry configured`,
      );
    }
    const entry = (): CredentialEntry | undefined =>
      named ? namedEntry : credentialFor(key);
    const wrongKind = (
      kind: string,
      got: CredentialEntry | undefined,
    ): never => {
      throw new Error(
        `credentialRef '${key}' must hold a ${kind} credential for ${target}, ` +
          `got ${got?.credential?.kind ?? 'none'}`,
      );
    };
    return {
      require<K extends CredentialKind>(kind: K): OfKind<K> {
        const e = entry();
        const c = e?.credential;
        if (c?.kind !== kind) return wrongKind(kind, e);
        return c as OfKind<K>;
      },
      optional<K extends CredentialKind>(kind: K): { credential?: OfKind<K> } {
        const e = entry();
        const c = e?.credential;
        if (!c) {
          if (named) return wrongKind(kind, e); // named, resolved, empty
          return {}; // omitted and empty: anonymous, on purpose
        }
        if (c.kind !== kind) return wrongKind(kind, e); // never "ignore it"
        return { credential: c as OfKind<K> };
      },
      requireApiBaseUrl(): string {
        const e = entry();
        if (!e?.apiBaseUrl) {
          throw new Error(
            `credentialRef '${key}' must carry an apiBaseUrl for ${target}`,
          );
        }
        return e.apiBaseUrl;
      },
      refuseAny(): void {
        if (named) {
          throw new Error(
            `${target} takes no credential, so credentialRef '${key}' cannot apply`,
          );
        }
      },
    };
  };
}
