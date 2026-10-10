export function parseTelegramImportArgv(
  argv: readonly string[],
): { readonly updatePath: string; readonly configPath: string } {
  const fail = (): never => {
    throw new Error('Telegram import failed.');
  };
  if (!Array.isArray(argv) || argv.length !== 4) {
    return fail();
  }
  let updatePath: string | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < 4; i += 2) {
    const flag: unknown = argv[i];
    const value: unknown = argv[i + 1];
    if (
      typeof flag !== 'string' ||
      typeof value !== 'string' ||
      value.trim().length === 0
    ) {
      return fail();
    }
    if (flag === '--update' && updatePath === undefined) {
      updatePath = value;
    } else if (flag === '--config' && configPath === undefined) {
      configPath = value;
    } else {
      return fail();
    }
  }
  if (updatePath === undefined || configPath === undefined) {
    return fail();
  }
  return { updatePath, configPath };
}
