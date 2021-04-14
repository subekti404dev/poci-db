import * as Md5 from "spark-md5";
import { encode } from "base-64";

const MD5_CHUNK_SIZE = 32768;
const setImmediateShim = global.setImmediate || global.setTimeout;

const thisBtoa = (str) => {
 if (!global.btoa) {
  return encode(str);
 }
 return btoa(str);
};

class ReplicationUtils {
 public async generateReplicationId(src, target, opts) {
  var docIds = opts.doc_ids ? opts.doc_ids.sort(this.collate) : "";
  var filterFun = opts.filter ? opts.filter.toString() : "";
  var queryParams = "";
  var filterViewName = "";
  var selector = "";

  if (opts.selector) {
   selector = JSON.stringify(opts.selector);
  }

  if (opts.filter && opts.query_params) {
   queryParams = JSON.stringify(
    this.sortObjectPropertiesByKey(opts.query_params)
   );
  }

  if (opts.filter && opts.filter === "_view") {
   filterViewName = opts.view.toString();
  }

  const res = await Promise.all([src.id(), target.id()]);
  const queryData =
   res[0] +
   res[1] +
   filterFun +
   filterViewName +
   queryParams +
   docIds +
   selector;
  const getMD5 = async (queryData): Promise<string> => {
   return new Promise((resolve) => {
    this.binaryMd5(queryData, resolve);
   });
  };
  const md5sum: string = await getMD5(queryData);
  return "_local/" + md5sum.replace(/\//g, ".").replace(/\+/g, "_");
 }

 private collate(a, b) {
  if (a === b) {
   return 0;
  }

  a = this.normalizeKey(a);
  b = this.normalizeKey(b);

  var ai = this.collationIndex(a);
  var bi = this.collationIndex(b);
  if (ai - bi !== 0) {
   return ai - bi;
  }
  switch (typeof a) {
   case "number":
    return a - b;
   case "boolean":
    return a < b ? -1 : 1;
   case "string":
    return this.stringCollate(a, b);
   default:
    break;
  }
  return Array.isArray(a) ? this.arrayCollate(a, b) : this.objectCollate(a, b);
 }

 private normalizeKey(key) {
  switch (typeof key) {
   case "undefined":
    return null;
   case "number":
    if (key === Infinity || key === -Infinity || isNaN(key)) {
     return null;
    }
    return key;
   case "object":
    var origKey = key;
    if (Array.isArray(key)) {
     var len = key.length;
     key = new Array(len);
     for (var i = 0; i < len; i++) {
      key[i] = this.normalizeKey(origKey[i]);
     }
     /* istanbul ignore next */
    } else if (key instanceof Date) {
     return key.toJSON();
    } else if (key !== null) {
     // generic object
     key = {};
     for (var k in origKey) {
      if (origKey.hasOwnProperty(k)) {
       var val = origKey[k];
       if (typeof val !== "undefined") {
        key[k] = this.normalizeKey(val);
       }
      }
     }
    }
    break;
   default:
    break;
  }
  return key;
 }

 private sortObjectPropertiesByKey(queryParams) {
  return Object.keys(queryParams)
   .sort(this.collate)
   .reduce(function (result, key) {
    result[key] = queryParams[key];
    return result;
   }, {});
 }

 private binaryMd5(data, callback) {
  var inputIsString = typeof data === "string";
  var len = inputIsString ? data.length : data.size;
  var chunkSize = Math.min(MD5_CHUNK_SIZE, len);
  var chunks = Math.ceil(len / chunkSize);
  var currentChunk = 0;
  var buffer = inputIsString ? new Md5() : new Md5.ArrayBuffer();

  var append = inputIsString ? this.appendString : this.appendBlob;

  const next = () => {
   setImmediateShim(loadNextChunk);
  };

  const done = () => {
   var raw = buffer.end(true);
   var base64 = this.rawToBase64(raw);
   callback(base64);
   buffer.destroy();
  };

  const loadNextChunk = () => {
   var start = currentChunk * chunkSize;
   var end = start + chunkSize;
   currentChunk++;
   if (currentChunk < chunks) {
    append(buffer, data, start, end, next);
   } else {
    append(buffer, data, start, end, done);
   }
  };
  loadNextChunk();
 }

 private collationIndex(x): number | any {
  var id = ["boolean", "number", "string", "object"];
  var idx = id.indexOf(typeof x);
  //false if -1 otherwise true, but fast!!!!1
  if (~idx) {
   if (x === null) {
    return 1;
   }
   if (Array.isArray(x)) {
    return 5;
   }
   return idx < 3 ? idx + 2 : idx + 3;
  }
  /* istanbul ignore next */
  if (Array.isArray(x)) {
   return 5;
  }
 }

 private stringCollate(a, b) {
  return a === b ? 0 : a > b ? 1 : -1;
 }

 private objectCollate(a, b) {
  var ak = Object.keys(a),
   bk = Object.keys(b);
  var len = Math.min(ak.length, bk.length);
  for (var i = 0; i < len; i++) {
   // First sort the keys
   var sort = this.collate(ak[i], bk[i]);
   if (sort !== 0) {
    return sort;
   }
   // if the keys are equal sort the values
   sort = this.collate(a[ak[i]], b[bk[i]]);
   if (sort !== 0) {
    return sort;
   }
  }
  return ak.length === bk.length ? 0 : ak.length > bk.length ? 1 : -1;
 }

 private arrayCollate(a, b) {
  var len = Math.min(a.length, b.length);
  for (var i = 0; i < len; i++) {
   var sort = this.collate(a[i], b[i]);
   if (sort !== 0) {
    return sort;
   }
  }
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
 }

 private appendBlob(buffer, blob, start, end, callback) {
  if (start > 0 || end < blob.size) {
   // only slice blob if we really need to
   blob = this.sliceBlob(blob, start, end);
  }
  this.readAsArrayBuffer(blob, function (arrayBuffer) {
   buffer.append(arrayBuffer);
   callback();
  });
 }

 private appendString(buffer, string, start, end, callback) {
  if (start > 0 || end < string.length) {
   // only create a substring if we really need to
   string = string.substring(start, end);
  }
  buffer.appendBinary(string);
  callback();
 }

 private rawToBase64(raw) {
  return thisBtoa(raw);
 }

 private sliceBlob(blob, start, end) {
  if (blob.webkitSlice) {
   return blob.webkitSlice(start, end);
  }
  return blob.slice(start, end);
 }

 private readAsArrayBuffer(blob, callback) {
  var reader = new FileReader();
  reader.onloadend = function (e: any) {
   var result = e.target.result || new ArrayBuffer(0);
   callback(result);
  };
  reader.readAsArrayBuffer(blob);
 }
}

export default new ReplicationUtils();
