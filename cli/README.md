# halo

`halo` — operator + payer CLI for [Halo](https://github.com/warden-protocol/run-halo). Run and pay for x402-gated services from the terminal.

## Install

Requires Node.js >= 20. The install script clones the repo, builds the CLI, and links the `halo` command globally:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/warden-protocol/run-halo/main/skill/scripts/install.sh)
halo --help
```

Or build from source:

```bash
git clone https://github.com/warden-protocol/run-halo.git
cd run-halo/cli
npm install && npm run build && npm link
halo --help
```

## Commands

| Command | Purpose |
| --- | --- |
| `halo setup`   | Initialize config / wallet |
| `halo doctor`  | Check environment and configuration |
| `halo serve`   | Run an x402-gated service (operator side) |
| `halo service` | Manage services |
| `halo pay`     | Pay an x402-gated endpoint |
| `halo consume` | Consume / call a paid resource |
| `halo vault`   | Manage the vault |
| `halo link`    | Link accounts / services |
| `halo status`  | Show status |

Run `halo <command> --help` for details on any command.

## License

Apache-2.0
