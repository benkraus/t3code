"use client";

import type { ProviderInstanceEnvironmentVariable } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import type { ProviderCredentialEnvironmentVariableDefinition } from "./providerDriverMeta";

export function setCredentialEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  credential: ProviderCredentialEnvironmentVariableDefinition,
  rawValue: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const value = rawValue.trim();
  const existingIndex = environment.findIndex((variable) => variable.name === credential.name);
  const existing = existingIndex >= 0 ? environment[existingIndex] : undefined;

  if (value.length === 0) {
    if (existing?.valueRedacted === true) {
      return environment;
    }
    return environment.filter((variable) => variable.name !== credential.name);
  }

  const nextVariable: ProviderInstanceEnvironmentVariable = {
    name: credential.name,
    value,
    sensitive: true,
    valueRedacted: false,
  };

  if (existingIndex < 0) {
    return [...environment, nextVariable];
  }

  return environment.map((variable, index) => (index === existingIndex ? nextVariable : variable));
}

export function credentialEnvironmentVariableNames(
  credentials: readonly ProviderCredentialEnvironmentVariableDefinition[] | undefined,
): ReadonlySet<string> {
  return new Set(credentials?.map((credential) => credential.name) ?? []);
}

interface ProviderCredentialEnvironmentFieldsProps {
  readonly credentials: readonly ProviderCredentialEnvironmentVariableDefinition[] | undefined;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly idPrefix: string;
  readonly variant: "card" | "dialog";
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}

export function ProviderCredentialEnvironmentFields({
  credentials,
  environment,
  idPrefix,
  variant,
  onChange,
}: ProviderCredentialEnvironmentFieldsProps) {
  if (!credentials || credentials.length === 0) {
    return null;
  }

  const descriptionClassName =
    variant === "card"
      ? "mt-1 block text-xs text-muted-foreground"
      : "text-[11px] text-muted-foreground";

  return (
    <>
      {credentials.map((credential) => {
        const inputId = `${idPrefix}-${credential.name}`;
        const existing = environment.find((variable) => variable.name === credential.name);
        const value = existing?.valueRedacted ? "" : (existing?.value ?? "");
        const placeholder =
          existing?.valueRedacted === true
            ? "Stored secret - enter a new value to replace"
            : credential.placeholder;
        const label = (
          <>
            <span className="text-xs font-medium text-foreground">{credential.label}</span>
            <code className="ml-2 rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
              {credential.name}
            </code>
          </>
        );
        const description = credential.description ? (
          <span className={descriptionClassName}>{credential.description}</span>
        ) : null;
        const commit = (next: string) =>
          onChange(setCredentialEnvironmentVariable(environment, credential, next));

        if (variant === "card") {
          return (
            <div key={credential.name} className="border-t border-border/60 px-4 py-3 sm:px-5">
              <label htmlFor={inputId} className="block">
                {label}
                <DraftInput
                  id={inputId}
                  className="mt-1.5"
                  type="password"
                  autoComplete="off"
                  value={value}
                  onCommit={commit}
                  placeholder={placeholder}
                  spellCheck={false}
                />
                {description}
              </label>
            </div>
          );
        }

        return (
          <label key={credential.name} htmlFor={inputId} className={cn("grid gap-2")}>
            <span>
              {label}
              {description}
            </span>
            <Input
              id={inputId}
              className="bg-background"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => commit(event.target.value)}
              placeholder={placeholder}
              spellCheck={false}
            />
          </label>
        );
      })}
    </>
  );
}
