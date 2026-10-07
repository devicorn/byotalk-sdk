# Changelog

## 0.2.0

### Breaking

- **Database drivers are no longer installed with `byotalk`.** `pg`, `mysql2` and `mongodb` were optional dependencies, so npm installed them in every web and mobile app. They are now optional peer dependencies used only by the CLI. Run the CLI with the driver it needs: `npx -p byotalk -p pg byotalk db migrate --url …` (or `mysql2`, `mongodb`). `--print-sql` needs no driver. If the driver is missing, the CLI says which one to add.
- **`createChat()` and `new Chat()` throw when `crypto.getRandomValues` is missing.** Message ids (`clientMsgId`) are UUIDs, and Hermes has no Web Crypto. Before, the first send crashed. Now construction fails with an error that names the polyfill. Install `react-native-get-random-values` and import it first in your entry file.

### Fixes

- **React Native: `mmkvPersistence()` works with react-native-mmkv v4.** v4 replaced `new MMKV()` with `createMMKV()` and renamed `delete` to `remove`. Both shapes are detected, and v2/v3 keep working. You can also pass your own instance: `mmkvPersistence(storage)`.
- **React Native: `createChat()` no longer leaks AppState and NetInfo listeners.** It now adds them on `connect()` and removes them on `disconnect()`. Before, each sign-out and sign-in left one listener of each behind.
- **`conversations.watch()` summaries follow metadata changes.** `conversation.updated` now updates `metadata` as well as `name` in `ConversationSummary`. Before, metadata was only refreshed on a full reload.

### Added

- **`conversation.hasOlder`** says whether the server has messages older than the oldest one loaded. It is set by the first page and updated by `loadOlder()` and resync. Use it instead of guessing from `oldestSeq > 1`.
- **`chatServer.messages.send()` types `clientMsgId` as a UUID**, the format the server requires (anything else is refused with 400).
- **CLI: a note when `--schema` ends in `_`.** The separator is added for you, so `--schema byotalk` gives `byotalk_messages`. The value is still used as given, so existing installs are unchanged.
