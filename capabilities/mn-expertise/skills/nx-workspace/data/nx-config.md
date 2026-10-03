# NX Configuration

## nx.json Task Pipeline

```json
{
  "targetDefaults": {
    "build": {
      "dependsOn": ["^build"],
      "cache": true,
      "inputs": ["production", "^production"]
    },
    "test": {
      "cache": true,
      "inputs": ["default", "^production"]
    },
    "lint": {
      "cache": true,
      "inputs": ["default", "{workspaceRoot}/biome.json"]
    },
    "format": {
      "cache": true,
      "inputs": ["default", "{workspaceRoot}/biome.json"]
    }
  },
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/?(*.)+(spec|test).[jt]s?(x)?(.snap)",
      "!{projectRoot}/tsconfig.spec.json"
    ],
    "sharedGlobals": ["{workspaceRoot}/babel.config.json"]
  }
}
```

## Cacheable Operations

```json
{
  "tasksRunnerOptions": {
    "default": {
      "runner": "nx/tasks-runners/default",
      "options": {
        "cacheableOperations": ["build", "lint", "test", "typecheck", "format-check"]
      }
    }
  }
}
```

## CLI Configuration

```json
{
  "cli": {
    "packageManager": "bun"
  },
  "affected": {
    "defaultBase": "main"
  }
}
```

## Build Optimization Commands

```bash
# Run tests in parallel
npx nx run-many -t test --parallel=4

# Only affected projects
npx nx affected -t build --base=main

# With specific head
npx nx affected -t test --base=main --head=HEAD
```
