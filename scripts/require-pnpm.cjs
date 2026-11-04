if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) {
  console.error('This repository uses pnpm workspaces. Run pnpm install from the repository root.');
  process.exit(1);
}
