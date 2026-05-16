```markdown
# Super-Productivity-MCP Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you how to contribute to the Super-Productivity-MCP codebase, a TypeScript project focused on productivity tooling. You'll learn the project's coding conventions, how to implement security improvements (especially for IPC directory handling), and how to write and update tests. The repository emphasizes secure file operations, modular code organization, and clear commit practices.

## Coding Conventions

- **File Naming:**  
  Use camelCase for file names.  
  _Example:_  
  ```
  ipcHandler.ts
  userSettingsManager.ts
  ```

- **Import Style:**  
  Use relative imports for internal modules.  
  _Example:_  
  ```typescript
  import { validateDirectory } from './validateDirectory';
  import { getUserSettings } from '../settings/userSettingsManager';
  ```

- **Export Style:**  
  Use named exports instead of default exports.  
  _Example:_  
  ```typescript
  // In src/ipc/directories.ts
  export function hardenDirectoryPermissions(path: string): boolean { ... }
  ```

- **Commit Patterns:**  
  - Freeform commit messages, sometimes prefixed (e.g., `security:`).
  - Average commit message length: ~82 characters.
  - _Example:_  
    ```
    security: reject symlinks in IPC directory for improved safety
    ```

## Workflows

### Security Hardening and Validation
**Trigger:** When someone wants to enhance security around IPC directory access or file operations.  
**Command:** `/harden-ipc-directory`

1. **Modify Security Logic:**  
   Edit `src/ipc/directories.ts` to add or improve security checks. This may include:
   - Hardening permissions (e.g., setting restrictive file modes)
   - Rejecting symlinks to prevent directory traversal
   - Validating input paths to avoid unsafe operations

   _Example:_  
   ```typescript
   import { lstatSync } from 'fs';

   export function isSafeDirectory(path: string): boolean {
     const stats = lstatSync(path);
     if (stats.isSymbolicLink()) {
       throw new Error('Symlinks are not allowed for IPC directories.');
     }
     // Additional permission checks...
     return true;
   }
   ```

2. **Update or Create Tests:**  
   Update or add tests in `tests/unit/directories.test.ts` to cover the new or modified security logic.

   _Example:_  
   ```typescript
   import { isSafeDirectory } from '../../src/ipc/directories';

   test('should throw error for symlink directories', () => {
     expect(() => isSafeDirectory('/tmp/symlink-dir')).toThrow();
   });
   ```

3. **(Optional) Update Plugin Logic:**  
   If plugin-level changes are needed, update `plugin/plugin.js` accordingly.

4. **Commit Your Changes:**  
   Use a descriptive commit message, optionally prefixed with `security:`.

## Testing Patterns

- **Test File Naming:**  
  Test files follow the `*.test.*` pattern, typically placed in a `tests/unit/` directory.  
  _Example:_  
  ```
  tests/unit/directories.test.ts
  ```

- **Testing Framework:**  
  The specific framework is unknown, but tests are written in TypeScript and follow standard test function conventions.

- **Test Example:**  
  ```typescript
  import { isSafeDirectory } from '../../src/ipc/directories';

  test('should validate directory permissions', () => {
    expect(isSafeDirectory('/tmp/secure-dir')).toBe(true);
  });
  ```

## Commands

| Command               | Purpose                                                         |
|-----------------------|-----------------------------------------------------------------|
| /harden-ipc-directory | Start the workflow to improve IPC directory security and testing |
```
