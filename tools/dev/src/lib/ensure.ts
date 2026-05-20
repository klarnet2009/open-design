export type EnsureAssertion = {
  or(factory: () => Error): void;
};

export type EnsureValue<T> = {
  or(factory: () => Error): T;
};

export function ensure(condition: boolean): EnsureAssertion {
  return {
    or(factory) {
      if (!condition) throw factory();
    },
  };
}

export namespace ensure {
  export function defined<T>(value: T | null | undefined): EnsureValue<T> {
    return {
      or(factory) {
        if (value == null) throw factory();
        return value;
      },
    };
  }
}
