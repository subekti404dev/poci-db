import InternetUtils from "./utils/internet.utils";
import ReplicationUtils from "./utils/replication.utils";
import PouchDB from "./utils/pouch-db.utils";
import ReactNativeUtils from "./utils/react-native.utils";

const ID_META_DOC = "meta";
const PREFIX_META_DB = "meta_";

if (ReactNativeUtils.isReactNative) {
 ReactNativeUtils.setAdapter(PouchDB);
}

const initialDataMeta = {
 _id: ID_META_DOC,
 clientId: PouchDB.createId(),
 tsUpload: new Date(0).toJSON(),
 unuploadeds: {},
};

interface PociDBOptions {
 isUseRemote?: boolean;
 isUseData?: boolean;
 optionsLocal?: object;
 optionsRemote?: object;
}

interface DataMeta {
 _id: string;
 clientId: string;
 tsUpload: string;
 unuploadeds: object;
}

class PociDB {
 private _options: PociDBOptions = {
  isUseData: true,
  isUseRemote: true,
  optionsLocal: {},
  optionsRemote: {},
 };
 private _data: any;
 private _dataMeta: DataMeta;
 private _isInitialized: boolean = false;
 private _dbLocal: any;
 private _dbMeta: any;
 private _dbRemote: any;
 private _single: boolean;

 private _changeFromRemote: any;
 private _subscribers: any[] = [];

 private _handlerLocalChange: any;
 private _handlerMetaChange: any;
 private _handlerRemoteChange: any;

 public name: string;
 public urlRemote: string;
 public dataDefault: any;
 public replicationId: string;

 constructor(options?: PociDBOptions) {
  if (options) {
   for (const key of Object.keys(options)) {
    if (options[key] !== undefined) {
     this._options[key] = options[key];
    }
    if (ReactNativeUtils.isReactNative) {
     if (!this._options.optionsLocal) {
      this._options.optionsLocal = {};
     }
     this._options.optionsLocal["adapter"] = "react-native-sqlite";
    }
   }
  }

  this.initializeProperties();
 }

 private initializeProperties() {
  // initialize in-memory data
  if (this._single) {
   this._data = this.dataDefault || {};
  } else if (this._options.isUseData) {
   this._data = this.dataDefault || [];
  }
  if (!this.urlRemote) this._options.isUseRemote = false;

  this._dataMeta = initialDataMeta;
  this._changeFromRemote = {}; // flag downloaded data from remote DB
  this._subscribers = []; // subscribers of data changes

  this._dbLocal = null;
  this._dbMeta = null;
  this._dbRemote = null;
 }

 public async initialize() {
  if (this._isInitialized) return;

  if (!this.name) {
   throw new Error("store must have name");
  }

  // initalize the databases
  this._dbLocal = new PouchDB(this.name, {
   auto_compaction: true,
   revs_limit: 2,
   ...this._options.optionsLocal,
  });
  this._dbMeta = new PouchDB(`${PREFIX_META_DB}${this.name}`, {
   auto_compaction: true,
   revs_limit: 2,
  });
  if (this._options.isUseRemote) {
   if (!this.urlRemote) {
    throw new Error(`store's urlRemote should not be ${this.urlRemote}`);
   }
   this._dbRemote = new PouchDB(`${this.urlRemote}${this.name}`, {
    ...this._options.optionsRemote,
   });
  }

  // init metadata
  const dataMetaOld = await this._dbMeta.getFailSafe(ID_META_DOC);
  if (dataMetaOld) {
   this._dataMeta = dataMetaOld;
  } else {
   await this.persistMeta();
   this._dataMeta = await this._dbMeta.getFailSafe(ID_META_DOC);
  }
  this.watchMeta();

  if (this._options.isUseRemote) {
   // sync data local-remote
   try {
    const online = await InternetUtils.isOnline(this.urlRemote);
    if (online) {
     await this._dbLocal.replicate.from(this._dbRemote, {
      batch_size: 1000,
      batches_limit: 2,
     });
    }
   } catch (err) {
    console.log(err);
   }
   await this.initUnuploadeds();
  }
  // init data from PouchDB to memory
  const docs = await this._dbLocal.getDocs();
  if (this._single) {
   this._data = docs.find((doc) => doc._id === this._single) || this._data;
  } else if (this._options.isUseData) {
   this._data = docs.filter(
    (doc) => !("deletedAt" in doc) || doc.deletedAt === null
   );
   this.sortData(this._data);
   this._data = this.filterData(this._data);
  }

  this._isInitialized = true;
  if (this._single || this._options.isUseData) {
   this.notifySubscribers(this._data);
  } else {
   this.notifySubscribers(docs);
  }

  this.watchRemote();
  this.watchLocal();
 }

 public async deinitialize() {
  this.unwatchMeta();
  this.unwatchLocal();
  this.unwatchRemote();
  await this._dbLocal.close();
  await this._dbMeta.close();
  if (this._dbRemote) {
   await this._dbRemote.close();
  }
  this.initializeProperties();
  this._isInitialized = false;
 }

 // private
 private async persistMeta() {
  try {
   await this._dbMeta.put(this._dataMeta);
  } catch (err) {
   console.log(err);
  }
 }

 private watchMeta() {
  this._handlerMetaChange = this._dbMeta
   .changes({
    since: "now",
    live: true,
    include_docs: true,
   })
   .on("change", (change) => {
    const doc = change.doc;
    if (doc._id !== ID_META_DOC) return;
    this._dataMeta = doc;
   })
   .on("error", (err) => {
    console.log(`${PREFIX_META_DB}${this.name}.changes`, "error", err);
   });
 }

 private unwatchMeta() {
  if (this._handlerMetaChange) {
   this._handlerMetaChange.cancel();
  }
 }

 private async initUnuploadeds() {
  if (!this._options.isUseRemote) return;

  try {
   const replicationId =
    this.replicationId ||
    (await ReplicationUtils.generateReplicationId(this._dbLocal, this._dbRemote, {}));

   const replicationDoc = await this._dbLocal.get(replicationId);
   const unuploadeds = await this._dbLocal.changes({
    since: replicationDoc.last_seq,
    include_docs: true,
   });

   if (!this._dataMeta.unuploadeds) this._dataMeta.unuploadeds = {};
   for (let result of unuploadeds.results) {
    const doc = result.doc;
    this._dataMeta.unuploadeds[doc._id] = true;
   }
   if (unuploadeds.results.length > 0) {
    this.persistMeta();
   }
  } catch (err) {
   console.log(err);
  }
 }

 private watchRemote() {
  if (!this._options.isUseRemote) return;

  this._handlerRemoteChange = this._dbLocal.replicate
   .from(this._dbRemote, {
    live: true,
    retry: true,
   })
   .on("change", (change) => {
    for (let doc of change.docs) {
     this._changeFromRemote[doc._id] = true;
     this.updateMemory(doc);
    }
    this.notifySubscribers(change.docs);
   })
   .on("error", (err) => {
    console.log(`${this.name}.from`, "error", err);
   });
 }

 private unwatchRemote() {
  if (this._handlerRemoteChange) {
   this._handlerRemoteChange.cancel();
  }
 }

 private watchLocal() {
  this._handlerLocalChange = this._dbLocal
   .changes({
    since: "now",
    live: true,
    include_docs: true,
   })
   .on("change", (change) => {
    const doc = change.doc;
    if (this._changeFromRemote[doc._id]) {
     delete this._changeFromRemote[doc._id];
    } else {
     this.updateMemory(doc);
     if (doc._deleted) {
      delete this._dataMeta.unuploadeds[doc._id];
      this.persistMeta();
     } else if (
      doc.dirtyBy &&
      doc.dirtyBy.clientId === this._dataMeta.clientId
     ) {
      this._dataMeta.unuploadeds[doc._id] = true;
      this.persistMeta();
     }
     this.notifySubscribers([doc]);
    }
   })
   .on("error", (err) => {
    console.log(`${this.name}.changes`, "error", err);
   });
 }

 unwatchLocal() {
  if (this._handlerLocalChange) {
   this._handlerLocalChange.cancel();
  }
 }

 private updateMemory(doc) {
  if (!this._options.isUseData) return;

  if (this._single) {
   if (doc._id === this._single) {
    this._data = doc;
   }
  } else {
   const isDeleted = doc.deletedAt || doc._deleted;
   const index = this._data.findIndex((item) => item._id === doc._id);
   if (index !== -1) {
    if (isDeleted) {
     this._data.splice(index, 1);
    } else {
     this._data[index] = doc;
    }
   } else {
    if (isDeleted) {
     // do nothing
    } else {
     this._data.push(doc);
    }
   }
   this.sortData(this._data);
   this._data = this.filterData(this._data);
  }
 }

 /* data upload (from local DB to remote DB) */
 public checkIsUploaded(doc) {
  return !(doc._id in this._dataMeta.unuploadeds);
 }

 public countUnuploadeds() {
  const keys = Object.keys(this._dataMeta.unuploadeds);
  return keys.length;
 }

 public async upload() {
  if (!this._options.isUseRemote) return;

  const online = await InternetUtils.isOnline(this.urlRemote);

  if (online) {
   await this._dbLocal.replicate.to(this._dbRemote);
   const ids = Object.keys(this._dataMeta.unuploadeds);
   for (let id of ids) {
    delete this._dataMeta.unuploadeds[id];
   }
   this._dataMeta.tsUpload = new Date().toJSON();
   this.persistMeta();
   this.notifySubscribers([]);
  }
 }

 sortData(data: any[]) {
  // do no sorting, override this method to sort
 }
 filterData(data: any[]) {
  return data;
  //do no filter, override this method to filter
 }

 /* manipulation of array data (non-single) */

 public async addItem(payload, user = null) {
  const id = this._dbLocal.createId();
  await this.addItemWithId(id, payload, user);
 }

 public async addItemWithId(id, payload, user: any = {}) {
  const now = new Date().toJSON();
  const actionBy = this.createActionBy(user);
  await this._dbLocal.put({
   ...payload,
   _id: id,
   dirtyAt: now,
   dirtyBy: actionBy,
   createdAt: now,
   createdBy: actionBy,
   deletedAt: null,
  });
 }

 public async editItem(id, payload, user = {}) {
  const now = new Date().toJSON();
  const actionBy = this.createActionBy(user);
  const doc = await this._dbLocal.getFailSafe(id);
  if (!doc) return;

  await this._dbLocal.put({
   ...doc,
   ...payload,
   dirtyAt: now,
   dirtyBy: actionBy,
   updatedAt: now,
   updatedBy: actionBy,
  });
 }

 public async deleteItem(id, user = {}) {
  const now = new Date().toJSON();
  const actionBy = this.createActionBy(user);
  const doc = await this._dbLocal.getFailSafe(id);
  if (!doc) return;

  const isRealDelete = doc.deletedAt || doc.createdAt > this._dataMeta.tsUpload;
  if (isRealDelete) {
   await this._dbLocal.remove(doc);
  } else {
   await this._dbLocal.put({
    ...doc,
    dirtyAt: now,
    dirtyBy: actionBy,
    deletedAt: now,
    deletedBy: actionBy,
   });
  }
 }

 public async checkIdExist(id) {
  const doc = await this._dbLocal.getFailSafe(id);
  if (!doc) {
   return false;
  } else {
   return true;
  }
 }

 private createActionBy(user) {
  user = { ...user };
  delete user._id;
  delete user._rev;
  for (let name of ["created", "updated", "deleted", "dirty"]) {
   delete user[`${name}At`];
   delete user[`${name}By`];
  }
  user.clientId = this._dataMeta.clientId;
  return user;
 }

 /* manipulation of single data (non-array) */

 public async editSingle(payload) {
  const doc = (await this._dbLocal.getFailSafe(this._single)) || {
   _id: this._single,
  };
  await this._dbLocal.put({
   ...doc,
   ...payload,
  });
 }

 public async deleteSingle() {
  const doc = (await this._dbLocal.getFailSafe(this._single)) || {
   _id: this._single,
  };
  const payload: any = {};
  if (doc._rev) {
   payload._rev = doc._rev;
   Object.assign(payload, this.dataDefault || {});
  }
  await this._dbLocal.put({
   _id: doc._id,
   ...payload,
  });
 }

 /* subscription manager */

 public subscribe(subscriber) {
  const index = this._subscribers.findIndex((item) => item === subscriber);
  if (index !== -1) return;

  this._subscribers.push(subscriber);
  return () => this.unsubscribe(subscriber);
 }

 public unsubscribe(subscriber) {
  const index = this._subscribers.findIndex((item) => item === subscriber);
  if (index === -1) return;

  this._subscribers.splice(index, 1);
 }

 private notifySubscribers(docs) {
  if (!this._isInitialized) return;

  if (this._options.isUseData) {
   // create new array/object reference
   if (this._single) {
    this._data = { ...this._data };
   } else {
    this._data = Array.from(this._data);
   }
  }
  for (let subscriber of this._subscribers) {
   try {
    subscriber(docs);
   } catch (err) {
    console.log(err);
   }
  }
 }

 public get data() {
   return this._data;
 }
}

export default PociDB;
