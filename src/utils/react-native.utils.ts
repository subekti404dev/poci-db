import * as WebSqlPouchCore from "pouchdb-adapter-websql-core";
import * as sqlitePlugin from "react-native-sqlite-storage";

class RNUtils {
 private static openDatabase(opts) {
  return (name, version, description, size) => {
   const data = { name, version, description, size };
   const sqlitePluginOpts = Object.assign({}, opts, data);
   return sqlitePlugin.openDatabase(sqlitePluginOpts);
  };
 }

 private static webSQL(opts, callback) {
  const websql = RNUtils.openDatabase(opts);
  const _opts = Object.assign({ websql: websql }, opts);

  if (
   "default" in WebSqlPouchCore &&
   typeof WebSqlPouchCore.default.call === "function"
  ) {
   WebSqlPouchCore.default.call(this, _opts, callback);
  } else {
   WebSqlPouchCore.call(this, _opts, callback);
  }
 }

 public static setAdapter(PouchDB): void {
  const cfg = RNUtils.webSQL;
  Object.assign(cfg, { valid: () => true, use_prefix: false });
  PouchDB.adapter("react-native-sqlite", cfg, true);
 }

 public static get isReactNative(): boolean {
  if (typeof navigator != "undefined" && navigator.product == "ReactNative") {
   return true;
  }
  return false;
 }
}

export default RNUtils;
