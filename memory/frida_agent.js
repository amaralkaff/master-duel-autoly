"use strict";
/**
 * Frida IL2CPP Agent for Yu-Gi-Oh! Master Duel
 *
 * Finds the native duel engine's XOR-obfuscated LP storage and provides
 * RPC methods for reading/writing LP at runtime.
 * Also supports IL2CPP runtime_invoke for calling managed methods (solo bot).
 *
 * LP is stored as: stored_value = XOR_KEY ^ actual_lp
 * At address: base_ptr + playerIndex * 0xDA4
 */

// ── IL2CPP API ──
const gameAsm = Process.getModuleByName("GameAssembly.dll");

function getExport(name) {
    const addr = gameAsm.findExportByName(name);
    if (!addr) throw new Error("IL2CPP export not found: " + name);
    return addr;
}

const il2cpp_domain_get = new NativeFunction(getExport("il2cpp_domain_get"), "pointer", []);
const il2cpp_domain_get_assemblies = new NativeFunction(getExport("il2cpp_domain_get_assemblies"), "pointer", ["pointer", "pointer"]);
const il2cpp_assembly_get_image = new NativeFunction(getExport("il2cpp_assembly_get_image"), "pointer", ["pointer"]);
const il2cpp_image_get_class_count = new NativeFunction(getExport("il2cpp_image_get_class_count"), "int", ["pointer"]);
const il2cpp_image_get_class = new NativeFunction(getExport("il2cpp_image_get_class"), "pointer", ["pointer", "int"]);
const il2cpp_class_get_name = new NativeFunction(getExport("il2cpp_class_get_name"), "pointer", ["pointer"]);
const il2cpp_class_get_namespace = new NativeFunction(getExport("il2cpp_class_get_namespace"), "pointer", ["pointer"]);
const il2cpp_class_get_methods = new NativeFunction(getExport("il2cpp_class_get_methods"), "pointer", ["pointer", "pointer"]);
const il2cpp_method_get_name = new NativeFunction(getExport("il2cpp_method_get_name"), "pointer", ["pointer"]);
const il2cpp_method_get_param_count = new NativeFunction(getExport("il2cpp_method_get_param_count"), "int", ["pointer"]);
const il2cpp_class_get_fields = new NativeFunction(getExport("il2cpp_class_get_fields"), "pointer", ["pointer", "pointer"]);
const il2cpp_field_get_name = new NativeFunction(getExport("il2cpp_field_get_name"), "pointer", ["pointer"]);
const il2cpp_field_get_offset = new NativeFunction(getExport("il2cpp_field_get_offset"), "int", ["pointer"]);
const il2cpp_field_is_literal = new NativeFunction(getExport("il2cpp_field_is_literal"), "bool", ["pointer"]);
const il2cpp_field_static_get_value = new NativeFunction(getExport("il2cpp_field_static_get_value"), "void", ["pointer", "pointer"]);
const il2cpp_thread_attach = new NativeFunction(getExport("il2cpp_thread_attach"), "pointer", ["pointer"]);

// ── IL2CPP runtime_invoke API (Phase 2) ──
const il2cpp_runtime_invoke = new NativeFunction(
    getExport("il2cpp_runtime_invoke"), "pointer",
    ["pointer", "pointer", "pointer", "pointer"]
);
const il2cpp_string_new = new NativeFunction(
    getExport("il2cpp_string_new"), "pointer", ["pointer"]
);
const il2cpp_method_get_param_name = new NativeFunction(
    getExport("il2cpp_method_get_param_name"), "pointer", ["pointer", "uint32"]
);
const il2cpp_method_get_return_type = new NativeFunction(
    getExport("il2cpp_method_get_return_type"), "pointer", ["pointer"]
);
const il2cpp_type_get_name = new NativeFunction(
    getExport("il2cpp_type_get_name"), "pointer", ["pointer"]
);
const il2cpp_method_get_param = new NativeFunction(
    getExport("il2cpp_method_get_param"), "pointer", ["pointer", "uint32"]
);

// Object introspection — needed to call methods on Dictionary objects
const il2cpp_object_get_class = new NativeFunction(
    getExport("il2cpp_object_get_class"), "pointer", ["pointer"]
);

// Object creation — for constructing Dictionary<string, object>
const il2cpp_object_new = new NativeFunction(
    getExport("il2cpp_object_new"), "pointer", ["pointer"]
);
const il2cpp_value_box = new NativeFunction(
    getExport("il2cpp_value_box"), "pointer", ["pointer", "pointer"]
);
const il2cpp_class_from_type = new NativeFunction(
    getExport("il2cpp_class_from_type"), "pointer", ["pointer"]
);

// GC handle management — prevent GC from collecting objects we're polling
const il2cpp_gchandle_new = new NativeFunction(
    getExport("il2cpp_gchandle_new"), "uint32", ["pointer", "int"]
);
const il2cpp_gchandle_free = new NativeFunction(
    getExport("il2cpp_gchandle_free"), "void", ["uint32"]
);
const il2cpp_gchandle_get_target = new NativeFunction(
    getExport("il2cpp_gchandle_get_target"), "pointer", ["uint32"]
);

// Optional IL2CPP API (may not exist in all builds)
function optExport(name, ret, args) {
    const addr = gameAsm.findExportByName(name);
    return addr ? new NativeFunction(addr, ret, args) : null;
}

const il2cpp_field_get_flags = optExport("il2cpp_field_get_flags", "int", ["pointer"]);
const il2cpp_method_get_flags = optExport("il2cpp_method_get_flags", "uint32", ["pointer", "pointer"]);

const FIELD_ATTRIBUTE_STATIC = 0x0010;
const METHOD_ATTRIBUTE_STATIC = 0x0010;

function readCStr(p) {
    if (p.isNull()) return "";
    try { return p.readCString() || ""; } catch (e) { return ""; }
}

// ── IL2CPP class/method helpers ──

function findEngineClass() {
    const domain = il2cpp_domain_get();
    const sizePtr = Memory.alloc(Process.pointerSize);
    const assemblies = il2cpp_domain_get_assemblies(domain, sizePtr);
    const count = sizePtr.readUInt();
    for (let i = 0; i < count; i++) {
        const asm = assemblies.add(i * Process.pointerSize).readPointer();
        const image = il2cpp_assembly_get_image(asm);
        const cc = il2cpp_image_get_class_count(image);
        for (let j = 0; j < cc; j++) {
            const klass = il2cpp_image_get_class(image, j);
            if (readCStr(il2cpp_class_get_namespace(klass)) === "YgomGame.Duel" &&
                readCStr(il2cpp_class_get_name(klass)) === "Engine") {
                return klass;
            }
        }
    }
    return null;
}

function getMethodAddr(klass, methodName) {
    const iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    while (true) {
        const method = il2cpp_class_get_methods(klass, iter);
        if (method.isNull()) return null;
        if (readCStr(il2cpp_method_get_name(method)) === methodName) {
            return method.readPointer(); // methodPointer is first field
        }
    }
}

function getStaticFieldPtr(klass, fieldName) {
    const iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    while (true) {
        const field = il2cpp_class_get_fields(klass, iter);
        if (field.isNull()) return null;
        if (readCStr(il2cpp_field_get_name(field)) === fieldName &&
            !il2cpp_field_is_literal(field)) {
            const buf = Memory.alloc(Process.pointerSize);
            il2cpp_field_static_get_value(field, buf);
            return buf.readPointer();
        }
    }
}

// ── Main-thread executor ──
// Queue callbacks to run on Unity's main thread via ContentViewControllerManager.Update hook

var _mainThreadQueue = [];
var _mainThreadHooked = false;

function setupMainThreadHook() {
    if (_mainThreadHooked) return true;

    var domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    var cvcmClass = _findClassForHook("YgomGame.Menu", "ContentViewControllerManager");
    if (!cvcmClass) { send("mainThreadHook: CVCM class not found"); return false; }

    var updateMethod = _findMethodForHook(cvcmClass, "Update", 0);
    if (!updateMethod) { send("mainThreadHook: Update method not found"); return false; }

    var updateAddr = updateMethod.readPointer();
    Interceptor.attach(updateAddr, {
        onEnter: function () {
            while (_mainThreadQueue.length > 0) {
                var cb = _mainThreadQueue.shift();
                try {
                    cb.result = cb.fn();
                    cb.done = true;
                } catch (e) {
                    cb.error = e.message;
                    cb.done = true;
                }
            }
        }
    });

    _mainThreadHooked = true;
    send("mainThreadHook: installed on CVCM.Update");
    return true;
}

// Minimal class/method finders used before _classCache is available
function _findClassForHook(ns, name) {
    var sizeOut = Memory.alloc(4);
    var assemblies = il2cpp_domain_get_assemblies(il2cpp_domain_get(), sizeOut);
    var count = sizeOut.readU32();
    for (var i = 0; i < count; i++) {
        var asm = assemblies.add(i * Process.pointerSize).readPointer();
        var image = il2cpp_assembly_get_image(asm);
        var cc = il2cpp_image_get_class_count(image);
        for (var j = 0; j < cc; j++) {
            var klass = il2cpp_image_get_class(image, j);
            if (readCStr(il2cpp_class_get_namespace(klass)) === ns &&
                readCStr(il2cpp_class_get_name(klass)) === name) {
                return klass;
            }
        }
    }
    return null;
}

function _findMethodForHook(klass, name, paramCount) {
    var iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    while (true) {
        var method = il2cpp_class_get_methods(klass, iter);
        if (method.isNull()) break;
        if (readCStr(il2cpp_method_get_name(method)) === name &&
            il2cpp_method_get_param_count(method) === paramCount) {
            return method;
        }
    }
    return null;
}

/**
 * Run a function on the Unity main thread. Blocks the Frida RPC thread
 * until the callback executes (max 30 seconds).
 */
function runOnMainThread(fn) {
    if (!_mainThreadHooked) {
        if (!setupMainThreadHook()) {
            throw new Error("Cannot set up main thread hook");
        }
    }
    var cb = { fn: fn, done: false, result: null, error: null };
    _mainThreadQueue.push(cb);

    for (var i = 0; i < 300; i++) {
        if (cb.done) {
            if (cb.error) throw new Error("Main thread: " + cb.error);
            return cb.result;
        }
        Thread.sleep(0.1);
    }
    throw new Error("Main thread callback timeout (30s)");
}

// ── Generalized class/method finders (cached) ──

const _classCache = {};  // "ns.name" -> klass pointer
var _interceptedCalls = {};  // captured Duel_begin/Duel_end params

function findClassByName(ns, name) {
    const key = ns + "." + name;
    if (_classCache[key]) return _classCache[key];

    const domain = il2cpp_domain_get();
    const sizePtr = Memory.alloc(Process.pointerSize);
    const assemblies = il2cpp_domain_get_assemblies(domain, sizePtr);
    const count = sizePtr.readUInt();
    for (let i = 0; i < count; i++) {
        const asm = assemblies.add(i * Process.pointerSize).readPointer();
        const image = il2cpp_assembly_get_image(asm);
        const cc = il2cpp_image_get_class_count(image);
        for (let j = 0; j < cc; j++) {
            const klass = il2cpp_image_get_class(image, j);
            if (readCStr(il2cpp_class_get_namespace(klass)) === ns &&
                readCStr(il2cpp_class_get_name(klass)) === name) {
                _classCache[key] = klass;
                return klass;
            }
        }
    }
    return null;
}

/**
 * Find a MethodInfo* by name on a class. Returns the MethodInfo pointer (NOT the code address).
 * paramCount: if >= 0, also match on parameter count. -1 = any.
 */
function findMethodByName(klass, name, paramCount) {
    if (paramCount === undefined) paramCount = -1;
    const iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    while (true) {
        const method = il2cpp_class_get_methods(klass, iter);
        if (method.isNull()) return null;
        if (readCStr(il2cpp_method_get_name(method)) === name) {
            if (paramCount < 0 || il2cpp_method_get_param_count(method) === paramCount) {
                return method;
            }
        }
    }
}

/**
 * Call a static method via il2cpp_runtime_invoke.
 * args: array of NativePointer values (already marshaled as void*).
 * Returns the Il2CppObject* result (may be null for void methods).
 * Throws on exception.
 */
function invokeStatic(methodInfo, args) {
    const exc = Memory.alloc(Process.pointerSize);
    exc.writePointer(ptr(0));

    let paramsPtr = ptr(0);
    if (args && args.length > 0) {
        paramsPtr = Memory.alloc(Process.pointerSize * args.length);
        for (let i = 0; i < args.length; i++) {
            paramsPtr.add(i * Process.pointerSize).writePointer(args[i]);
        }
    }

    const result = il2cpp_runtime_invoke(methodInfo, ptr(0), paramsPtr, exc);

    const excObj = exc.readPointer();
    if (!excObj.isNull()) {
        throw new Error("IL2CPP exception during invoke");
    }
    return result;
}

/**
 * Call an instance method via il2cpp_runtime_invoke.
 */
function invokeInstance(methodInfo, obj, args) {
    const exc = Memory.alloc(Process.pointerSize);
    exc.writePointer(ptr(0));

    let paramsPtr = ptr(0);
    if (args && args.length > 0) {
        paramsPtr = Memory.alloc(Process.pointerSize * args.length);
        for (let i = 0; i < args.length; i++) {
            paramsPtr.add(i * Process.pointerSize).writePointer(args[i]);
        }
    }

    const result = il2cpp_runtime_invoke(methodInfo, obj, paramsPtr, exc);

    const excObj = exc.readPointer();
    if (!excObj.isNull()) {
        throw new Error("IL2CPP exception during invoke");
    }
    return result;
}

/**
 * Allocate and write an int32 value, returning pointer suitable for runtime_invoke params.
 */
function boxInt32(value) {
    const buf = Memory.alloc(4);
    buf.writeS32(value | 0); // ensure integer via bitwise OR
    return buf;
}

/**
 * Allocate and write a boolean value, returning pointer suitable for runtime_invoke params.
 */
function boxBool(value) {
    const buf = Memory.alloc(4);
    buf.writeS32(value ? 1 : 0);
    return buf;
}

/**
 * Allocate and write a float value, returning pointer suitable for runtime_invoke params.
 */
function boxFloat(value) {
    const buf = Memory.alloc(4);
    buf.writeFloat(value);
    return buf;
}

/**
 * Create a managed Dictionary<string, object> and populate it with entries.
 * entries: [{key: "name", value: managedObjPtr}, ...]
 * Returns the Dictionary Il2CppObject* or null on failure.
 */
var _dictClassCache = null;
var _dictCtorCache = null;
var _dictAddCache = null;

function createManagedDict(entries) {
    // Find the Dictionary<string, object> class from Duel_end's parameter type
    if (!_dictClassCache) {
        var apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) { send("createManagedDict: API class not found"); return null; }
        var duelEndMethod = findMethodByName(apiClass, "Duel_end", 1);
        if (!duelEndMethod) { send("createManagedDict: Duel_end not found"); return null; }
        // Get the type of the first parameter (Dictionary<string, object>)
        var paramType = il2cpp_method_get_param(duelEndMethod, 0);
        if (!paramType || paramType.isNull()) { send("createManagedDict: param type null"); return null; }
        _dictClassCache = il2cpp_class_from_type(paramType);
        if (!_dictClassCache || _dictClassCache.isNull()) { send("createManagedDict: class from type failed"); return null; }
        // Find .ctor() and Add(key, value)
        _dictCtorCache = findMethodByName(_dictClassCache, ".ctor", 0);
        _dictAddCache = findMethodByName(_dictClassCache, "Add", 2);
        if (!_dictCtorCache) { send("createManagedDict: .ctor not found"); return null; }
        if (!_dictAddCache) { send("createManagedDict: Add not found"); return null; }
        send("createManagedDict: resolved Dictionary class at " + _dictClassCache);
    }

    // Create new Dictionary instance
    var dictObj = il2cpp_object_new(_dictClassCache);
    if (!dictObj || dictObj.isNull()) { send("createManagedDict: object_new failed"); return null; }

    // Call .ctor()
    invokeInstance(_dictCtorCache, dictObj, []);

    // Add entries
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        invokeInstance(_dictAddCache, dictObj, [e.key, e.value]);
    }

    return dictObj;
}

/**
 * Create a managed Il2CppString from a JS string.
 */
function createManagedString(str) {
    return il2cpp_string_new(Memory.allocUtf8String(str));
}

/**
 * Box an int32 as a managed System.Int32 object (for Dictionary<string, object> values).
 */
function boxInt32AsObject(value) {
    var int32Class = findClassByName("System", "Int32");
    if (!int32Class) return null;
    var buf = Memory.alloc(4);
    buf.writeS32(value | 0);
    return il2cpp_value_box(int32Class, buf);
}

/**
 * Read an Il2CppString object to a JavaScript string.
 */
function readIl2cppString(strObj) {
    if (!strObj || strObj.isNull()) return null;
    try {
        var len = strObj.add(0x10).readS32();
        if (len <= 0 || len > 10000) return null;
        return strObj.add(0x14).readUtf16String(len);
    } catch (e) {
        return null;
    }
}

/**
 * Try to unbox/read an IL2CPP object as a JavaScript value.
 * Handles: String, Int32, Boolean, Int64, Dictionary, List.
 * For unknown types, returns {_type: "FullName"}.
 */
function readObjectValue(obj, depth) {
    if (!obj || obj.isNull()) return null;
    if (depth === undefined) depth = 0;
    if (depth > 3) return "(max depth)";

    try {
        var klass = il2cpp_object_get_class(obj);
        var className = readCStr(il2cpp_class_get_name(klass));
        var ns = readCStr(il2cpp_class_get_namespace(klass));

        // Boxed primitives
        if (className === "String") return readIl2cppString(obj);
        if (className === "Int32") return obj.add(0x10).readS32();
        if (className === "UInt32") return obj.add(0x10).readU32();
        if (className === "Int64") {
            var lo = obj.add(0x10).readU32();
            var hi = obj.add(0x14).readS32();
            return hi * 0x100000000 + lo;
        }
        if (className === "Boolean") return !!obj.add(0x10).readU8();
        if (className === "Single") return obj.add(0x10).readFloat();
        if (className === "Double") return obj.add(0x10).readDouble();

        // Dictionary<K,V>
        if (className.indexOf("Dictionary") >= 0) {
            return readDictionaryObj(obj, klass, depth);
        }

        // List<T>
        if (className.indexOf("List") >= 0) {
            return readListObj(obj, klass, depth);
        }

        // Unknown type — return type info
        var fullName = ns ? ns + "." + className : className;
        return { _type: fullName, _ptr: obj.toString() };
    } catch (e) {
        return { _error: e.message, _ptr: obj.toString() };
    }
}

/**
 * Read a Dictionary IL2CPP object. Returns {_type, _count, entries: {key: value}}.
 */
function readDictionaryObj(dictObj, dictClass, depth) {
    var result = { _type: "Dictionary" };
    try {
        var getCount = findMethodByName(dictClass, "get_Count", 0);
        if (!getCount) return result;
        var countBox = invokeInstance(getCount, dictObj, []);
        if (!countBox || countBox.isNull()) return result;
        var count = countBox.add(0x10).readS32();
        result._count = count;
        if (count <= 0) return result;

        // Find _entries array field
        var fIter = Memory.alloc(Process.pointerSize);
        fIter.writePointer(ptr(0));
        var entriesField = null;
        while (true) {
            var field = il2cpp_class_get_fields(dictClass, fIter);
            if (field.isNull()) break;
            if (readCStr(il2cpp_field_get_name(field)) === "_entries") {
                entriesField = field;
                break;
            }
        }
        if (!entriesField) { result._note = "_entries not found"; return result; }

        var entriesOffset = il2cpp_field_get_offset(entriesField);
        var entriesArr = dictObj.add(entriesOffset).readPointer();
        if (entriesArr.isNull()) return result;

        var maxLen = entriesArr.add(0x18).readS32();
        var entries = {};
        var entrySizes = [32, 24]; // try both common entry sizes

        for (var si = 0; si < entrySizes.length; si++) {
            var entrySize = entrySizes[si];
            entries = {};
            var badKey = false;

            for (var i = 0; i < count && i < maxLen && i < 200; i++) {
                var entryBase = entriesArr.add(0x20 + i * entrySize);
                var hashCode = entryBase.readS32();

                var keyPtr = entryBase.add(8).readPointer();
                var valPtr = entryBase.add(8 + Process.pointerSize).readPointer();

                var keyVal = readObjectValue(keyPtr, depth + 1);
                if (keyVal === null && i === 0) { badKey = true; break; }

                var valVal = readObjectValue(valPtr, depth + 1);
                var keyStr = (keyVal !== null && keyVal !== undefined) ? String(keyVal) : "key_" + i;
                entries[keyStr] = valVal;
            }

            if (!badKey && Object.keys(entries).length > 0) break;
        }

        result.entries = entries;
    } catch (e) {
        result._error = e.message;
    }
    return result;
}

/**
 * Read a List IL2CPP object. Returns {_type, _count, items: [...]}.
 */
function readListObj(listObj, listClass, depth) {
    var result = { _type: "List" };
    try {
        var getCount = findMethodByName(listClass, "get_Count", 0);
        if (!getCount) return result;
        var countBox = invokeInstance(getCount, listObj, []);
        if (!countBox || countBox.isNull()) return result;
        var count = countBox.add(0x10).readS32();
        result._count = count;
        if (count <= 0) return result;

        // List<T> stores items in _items array field
        var fIter = Memory.alloc(Process.pointerSize);
        fIter.writePointer(ptr(0));
        var itemsField = null;
        while (true) {
            var field = il2cpp_class_get_fields(listClass, fIter);
            if (field.isNull()) break;
            if (readCStr(il2cpp_field_get_name(field)) === "_items") {
                itemsField = field;
                break;
            }
        }
        if (!itemsField) { result._note = "_items not found"; return result; }

        var itemsOffset = il2cpp_field_get_offset(itemsField);
        var itemsArr = listObj.add(itemsOffset).readPointer();
        if (itemsArr.isNull()) return result;

        var items = [];
        for (var i = 0; i < count && i < 500; i++) {
            var itemPtr = itemsArr.add(0x20 + i * Process.pointerSize).readPointer();
            items.push(readObjectValue(itemPtr, depth + 1));
        }
        result.items = items;
    } catch (e) {
        result._error = e.message;
    }
    return result;
}

/**
 * Get entries from a Dictionary<string, T> using runtime_invoke (safe approach).
 * Returns [{key: string, value: NativePointer}].
 */
function getDictEntries(dictObj) {
    var results = [];
    if (!dictObj || dictObj.isNull()) return results;

    try {
        var dictClass = il2cpp_object_get_class(dictObj);

        // Get count via get_Count()
        var getCount = findMethodByName(dictClass, "get_Count", 0);
        if (!getCount) { send("Dict: get_Count not found"); return results; }
        var countBox = invokeInstance(getCount, dictObj, []);
        if (!countBox || countBox.isNull()) return results;
        var count = countBox.add(0x10).readS32();
        if (count <= 0) return results;

        // Get keys via get_Keys(), then copy to array
        // Easier: use GetEnumerator and iterate
        // Actually simplest: use the class fields directly
        // Find _entries field on the dict class
        var fIter = Memory.alloc(Process.pointerSize);
        fIter.writePointer(ptr(0));
        var entriesField = null;
        while (true) {
            var field = il2cpp_class_get_fields(dictClass, fIter);
            if (field.isNull()) break;
            var fname = readCStr(il2cpp_field_get_name(field));
            if (fname === "_entries") {
                entriesField = field;
                break;
            }
        }

        if (!entriesField) {
            // Fallback: try to read keys one by one is complex
            // Just report the count
            send("Dict has " + count + " entries but _entries field not found");
            return results;
        }

        // Read _entries array from the object instance
        var entriesOffset = il2cpp_field_get_offset(entriesField);
        var entriesArr = dictObj.add(entriesOffset).readPointer();
        if (entriesArr.isNull()) return results;

        // Il2CppArray: header is 0x20 bytes, then elements
        // Entry struct for <string, T>: {int hash(4), int next(4), string key(8), T value(8)} = 24 bytes
        // BUT: need to check actual entry size based on alignment
        // Try 24 first, if keys look wrong try 32
        var maxLen = entriesArr.add(0x18).readS32(); // max_length
        var entrySize = 24; // default

        for (var i = 0; i < count && i < maxLen && i < 20; i++) {
            var entryBase = entriesArr.add(0x20 + i * entrySize);
            var hashCode = entryBase.readS32();
            // Skip free entries (hashCode < 0 in older .NET, or check next)
            if (hashCode < 0) continue;

            var key = entryBase.add(8).readPointer();
            var value = entryBase.add(16).readPointer();
            var keyStr = "";
            if (!key.isNull()) {
                try {
                    var len = key.add(0x10).readS32();
                    if (len > 0 && len < 200) {
                        keyStr = key.add(0x14).readUtf16String(len);
                    }
                } catch (e) {
                    // Entry size might be wrong, try 32
                    if (i === 0 && entrySize === 24) {
                        entrySize = 32;
                        i = -1; // restart
                        results = [];
                        continue;
                    }
                    keyStr = "?";
                }
            }
            if (!value.isNull()) {
                results.push({ key: keyStr, value: value });
            }
        }
    } catch (e) {
        send("getDictEntries error: " + e.message);
    }
    return results;
}

// ── Native LP resolution ──
// DLL_DuelGetLP is a P/Invoke. Its IL2CPP thunk:
//   1. Checks a cached function pointer
//   2. If null, resolves via P/Invoke
//   3. Calls the native function
//
// The native function:
//   mov eax, ecx                        ; playerIndex
//   mov rcx, qword ptr [rip + disp1]    ; base_ptr (LP storage)
//   and eax, 1
//   imul rdx, rax, 0xDA4               ; player stride
//   mov rax, qword ptr [rip + disp2]    ; key_ptr (XOR key)
//   movzx eax, word ptr [rax]           ; xor_key = *(uint16_t*)key_ptr
//   xor eax, dword ptr [rdx + rcx]      ; LP = xor_key ^ stored[player]
//   ret

let _resolved = false;
let _basePtrAddr = null;   // address of pointer to LP storage
let _keyPtrAddr = null;    // address of pointer to XOR key
let _duelGetLPFn = null;   // native DLL_DuelGetLP wrapper
let _duelRivalFn = null;   // native DLL_DuelRival wrapper
let _duelMyselfFn = null;  // native DLL_DuelMyself wrapper

function resolveNativeLP() {
    if (_resolved) return true;

    const domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    const engineKlass = findEngineClass();
    if (!engineKlass) { send("Engine class not found"); return false; }

    // Get IL2CPP method addresses
    const duelGetLPAddr = getMethodAddr(engineKlass, "DLL_DuelGetLP");
    const duelRivalAddr = getMethodAddr(engineKlass, "DLL_DuelRival");
    const duelMyselfAddr = getMethodAddr(engineKlass, "DLL_DuelMyself");
    if (!duelGetLPAddr) { send("DLL_DuelGetLP not found"); return false; }

    // Create callable wrappers (static P/Invoke: (int, MethodInfo*) -> int)
    _duelGetLPFn = new NativeFunction(duelGetLPAddr, "int32", ["int32", "pointer"]);
    if (duelRivalAddr) _duelRivalFn = new NativeFunction(duelRivalAddr, "int32", ["pointer"]);
    if (duelMyselfAddr) _duelMyselfFn = new NativeFunction(duelMyselfAddr, "int32", ["pointer"]);

    // Force P/Invoke resolution by calling the function
    try { _duelGetLPFn(0, ptr(0)); } catch (e) {}

    // Parse the IL2CPP thunk to find the cached native function pointer.
    // Pattern: mov rax, qword ptr [rip + disp32]  (opcode: 48 8B 05 xx xx xx xx)
    // Then later: call rax
    let cachedPtrAddr = null;
    for (let off = 0; off < 64; off++) {
        const b0 = duelGetLPAddr.add(off).readU8();
        const b1 = duelGetLPAddr.add(off + 1).readU8();
        const b2 = duelGetLPAddr.add(off + 2).readU8();
        if (b0 === 0x48 && b1 === 0x8B && b2 === 0x05) {
            // Found: 48 8B 05 [disp32]
            const disp = duelGetLPAddr.add(off + 3).readS32();
            const rip = duelGetLPAddr.add(off + 7); // next instruction
            cachedPtrAddr = rip.add(disp);
            break;
        }
    }

    if (!cachedPtrAddr) { send("Could not find P/Invoke cache in thunk"); return false; }

    const nativeFn = cachedPtrAddr.readPointer();
    if (nativeFn.isNull()) { send("Native function not resolved"); return false; }

    // Parse the native function to find base_ptr and key_ptr.
    // Pattern 1: mov rcx, qword ptr [rip + disp32]  (48 8B 0D xx xx xx xx)
    // Pattern 2: mov rax, qword ptr [rip + disp32]  (48 8B 05 xx xx xx xx) — second occurrence
    let found = 0;
    for (let off = 0; off < 48 && found < 2; off++) {
        const b0 = nativeFn.add(off).readU8();
        const b1 = nativeFn.add(off + 1).readU8();
        const b2 = nativeFn.add(off + 2).readU8();
        if (b0 === 0x48 && b1 === 0x8B) {
            if (b2 === 0x0D && found === 0) {
                // mov rcx, [rip + disp] — base_ptr
                const disp = nativeFn.add(off + 3).readS32();
                const rip = nativeFn.add(off + 7);
                _basePtrAddr = rip.add(disp);
                found++;
            } else if (b2 === 0x05 && found === 1) {
                // mov rax, [rip + disp] — key_ptr
                const disp = nativeFn.add(off + 3).readS32();
                const rip = nativeFn.add(off + 7);
                _keyPtrAddr = rip.add(disp);
                found++;
            }
        }
    }

    if (!_basePtrAddr || !_keyPtrAddr) {
        send("Could not parse native DuelGetLP (found=" + found + ")");
        return false;
    }

    _resolved = true;
    return true;
}

function readXorKey() {
    const keyPtr = _keyPtrAddr.readPointer();
    return keyPtr.readU16();
}

function readBasePtr() {
    return _basePtrAddr.readPointer();
}

const PLAYER_STRIDE = 0xDA4;

// ── Card reveal ──
// Master Duel zone constants (sequential, NOT bitmask!)
// z1-z5:  Monster zones (positions 1-5)
// z6-z10: Spell/Trap zones (positions 1-5)
// z11-z12: Extra Monster zones
// z13: HAND
// z14: Extra Deck
// z15: Main Deck
// z16: Graveyard
// z17: Banished
const ZONE_HAND = 13;
const ZONE_MONSTER_START = 1, ZONE_MONSTER_END = 5;
const ZONE_SPELL_START = 6, ZONE_SPELL_END = 10;
const ZONE_EXTRA_MONSTER_1 = 11, ZONE_EXTRA_MONSTER_2 = 12;
const ZONE_GRAVE = 16;

// Cached MethodInfo pointers for card query functions (called via invokeStatic)
var _cardMI = null;  // { getCardNum, getCardUID, getCardFace, getCardIDByUID }
var _pvpCardMI = null;  // PVP_ variants for online duels
var _pvpTurnMI = null;  // { whichTurn, getPhase, getTurnNum, getLP }
var _pvpCmdMI = null;   // PVP_ variants for command/dialog/list methods
var _pvpMyselfIndex = null;  // Corrected player index for PvP (DLL_DuelMyself is unreliable)
var _uidCardIdCache = {};    // UID -> cardId cache (survives intermittent 0 returns)

// ── PvP mode detection ──

/**
 * Read a static bool/byte field from Engine class by field name.
 * Uses il2cpp_field_static_get_value to read the raw byte.
 */
function readEngineStaticByte(engineKlass, fieldName) {
    var iter = Memory.alloc(Process.pointerSize);
    iter.writePointer(ptr(0));
    while (true) {
        var field = il2cpp_class_get_fields(engineKlass, iter);
        if (field.isNull()) return -1;
        if (readCStr(il2cpp_field_get_name(field)) === fieldName &&
            !il2cpp_field_is_literal(field)) {
            var buf = Memory.alloc(4);
            buf.writeU32(0);
            il2cpp_field_static_get_value(field, buf);
            return buf.readU8();
        }
    }
}

/**
 * Detect if current duel is online/PvP mode.
 * Tries reading isOnlineMode from both static and instance fields.
 * Falls back to probing PVP_DuelGetLP if field read fails.
 */
var _isOnlineCache = null;  // null = unknown, true/false = detected

function isOnlineMode() {
    if (_isOnlineCache !== null) return _isOnlineCache;

    var engineKlass = findEngineClass();
    if (!engineKlass) return false;

    // Try static field first
    var val = readEngineStaticByte(engineKlass, "isOnlineMode");
    if (val === 1) { _isOnlineCache = true; return true; }

    // Try reading as instance field from s_instance object
    var inst = getStaticFieldPtr(engineKlass, "s_instance");
    if (inst && !inst.isNull()) {
        try {
            // IL2CPP objects: header (klass+monitor) is 0x10 on 64-bit, then fields
            // isOnlineMode offset from field enumeration is relative offset within fields
            var fIter = Memory.alloc(Process.pointerSize);
            fIter.writePointer(ptr(0));
            while (true) {
                var field = il2cpp_class_get_fields(engineKlass, fIter);
                if (field.isNull()) break;
                if (readCStr(il2cpp_field_get_name(field)) === "isOnlineMode" &&
                    !il2cpp_field_is_literal(field)) {
                    var offset = il2cpp_field_get_offset(field);
                    var instVal = inst.add(offset).readU8();
                    if (instVal === 1) { _isOnlineCache = true; return true; }
                    break;
                }
            }
        } catch (e) {}
    }

    // Probe: try PVP_DuelGetLP(0) and see if it returns non-zero
    try {
        if (!resolvePvpCardMethods()) return false;  // don't cache — may succeed later
        if (_pvpTurnMI && _pvpTurnMI.getLP) {
            var pvpLP = callCardFn(_pvpTurnMI.getLP, [boxInt32(0)]);
            if (pvpLP > 0) {
                send("isOnlineMode: detected via PVP_DuelGetLP probe (LP=" + pvpLP + ")");
                _isOnlineCache = true;
                return true;
            }
            // Also try player 1 in case player 0 LP isn't ready yet
            pvpLP = callCardFn(_pvpTurnMI.getLP, [boxInt32(1)]);
            if (pvpLP > 0) {
                send("isOnlineMode: detected via PVP_DuelGetLP(1) probe (LP=" + pvpLP + ")");
                _isOnlineCache = true;
                return true;
            }
        }
    } catch (e) {}

    // Don't cache false — PvP detection may succeed on next call
    return false;
}

/** Reset online mode cache (call when duel state changes). */
function resetOnlineCache() {
    _isOnlineCache = null;
    _pvpMyselfIndex = null;
}

/**
 * Detect which PVP player index is "us" by cross-referencing
 * DLL_ (engine numbering, always "us" = 0) with PVP_ card counts.
 * Returns 0 or 1, or -1 if undetermined.
 */
function detectPvpMyselfIndex() {
    if (_pvpMyselfIndex !== null) return _pvpMyselfIndex;
    if (!_cardMI || !_pvpCardMI) return -1;

    try {
        // DLL_ player 0 hand count = our hand in engine numbering
        var dllHand = callCardFn(_cardMI.getCardNum, [boxInt32(0), boxInt32(13)]);
        var dllDeck = callCardFn(_cardMI.getCardNum, [boxInt32(0), boxInt32(15)]);
        if (dllHand <= 0 && dllDeck <= 0) return -1;  // duel not started yet

        // PVP_ player 0 and 1 hand+deck counts
        var pvpHand0 = callCardFn(_pvpCardMI.getCardNum, [boxInt32(0), boxInt32(13)]);
        var pvpDeck0 = callCardFn(_pvpCardMI.getCardNum, [boxInt32(0), boxInt32(15)]);
        var pvpHand1 = callCardFn(_pvpCardMI.getCardNum, [boxInt32(1), boxInt32(13)]);
        var pvpDeck1 = callCardFn(_pvpCardMI.getCardNum, [boxInt32(1), boxInt32(15)]);

        // Match: which PVP index has same hand+deck as DLL player 0?
        var dllTotal = dllHand + dllDeck;
        var pvpTotal0 = pvpHand0 + pvpDeck0;
        var pvpTotal1 = pvpHand1 + pvpDeck1;

        if (dllTotal === pvpTotal0 && dllTotal !== pvpTotal1) {
            _pvpMyselfIndex = 0;
            send("detectPvpMyself: matched player 0 (hand=" + dllHand + " deck=" + dllDeck + ")");
            return 0;
        }
        if (dllTotal === pvpTotal1 && dllTotal !== pvpTotal0) {
            _pvpMyselfIndex = 1;
            send("detectPvpMyself: matched player 1 (hand=" + dllHand + " deck=" + dllDeck + ")");
            return 1;
        }

        // Exact match failed (same totals) — try hand count only
        if (dllHand === pvpHand0 && dllHand !== pvpHand1) {
            _pvpMyselfIndex = 0;
            send("detectPvpMyself: hand match player 0 (hand=" + dllHand + ")");
            return 0;
        }
        if (dllHand === pvpHand1 && dllHand !== pvpHand0) {
            _pvpMyselfIndex = 1;
            send("detectPvpMyself: hand match player 1 (hand=" + dllHand + ")");
            return 1;
        }
    } catch (e) {}
    return -1;  // undetermined (both players have identical counts)
}

/**
 * Resolve PVP_ variants of card methods for online duels.
 */
function resolvePvpCardMethods() {
    if (_pvpCardMI) return true;

    var domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    var engineKlass = findEngineClass();
    if (!engineKlass) { send("resolvePvpCardMethods: Engine class not found"); return false; }

    var mapping = [
        ["PVP_DuelGetCardNum", 2],
        ["PVP_DuelGetCardUniqueID", 3],
        ["PVP_DuelGetCardFace", 3]
    ];
    var resolved = {};
    for (var i = 0; i < mapping.length; i++) {
        var mi = findMethodByName(engineKlass, mapping[i][0], mapping[i][1]);
        if (!mi) { send("resolvePvpCardMethods: " + mapping[i][0] + " NOT FOUND"); return false; }
        resolved[mapping[i][0]] = mi;
    }
    // CardIDByUniqueID: try PVP_ with "2" suffix first, then without, then DLL_ fallback
    var getIDByUID = findMethodByName(engineKlass, "PVP_DuelGetCardIDByUniqueID2", 1);
    if (!getIDByUID) getIDByUID = findMethodByName(engineKlass, "PVP_DuelGetCardIDByUniqueID", 1);
    if (!getIDByUID) {
        // Fall back to DLL_ version (shared engine data, works in both modes)
        resolveCardMethods();
        if (_cardMI) getIDByUID = _cardMI.getCardIDByUID;
    }
    if (!getIDByUID) { send("resolvePvpCardMethods: No CardIDByUniqueID method found"); return false; }
    resolved["getCardIDByUID"] = getIDByUID;

    // Turn/Phase/LP methods
    var turnMethods = [
        ["PVP_DuelWhichTurnNow", 0],
        ["PVP_DuelGetCurrentPhase", 0],
        ["PVP_DuelGetTurnNum", 0],
        ["PVP_DuelGetLP", 1]
    ];
    var turnResolved = {};
    for (var i = 0; i < turnMethods.length; i++) {
        var mi = findMethodByName(engineKlass, turnMethods[i][0], turnMethods[i][1]);
        if (!mi) { send("resolvePvpCardMethods: " + turnMethods[i][0] + " NOT FOUND"); }
        turnResolved[turnMethods[i][0]] = mi;
    }

    _pvpCardMI = {
        getCardNum:    resolved["PVP_DuelGetCardNum"],
        getCardUID:    resolved["PVP_DuelGetCardUniqueID"],
        getCardFace:   resolved["PVP_DuelGetCardFace"],
        getCardIDByUID: resolved["getCardIDByUID"]
    };

    _pvpTurnMI = {
        whichTurn: turnResolved["PVP_DuelWhichTurnNow"],
        getPhase:  turnResolved["PVP_DuelGetCurrentPhase"],
        getTurnNum: turnResolved["PVP_DuelGetTurnNum"],
        getLP:     turnResolved["PVP_DuelGetLP"]
    };

    // Reuse card name lookup from DLL resolve (it's shared)
    if (_cardMI && _cardMI.contentGetInstance) {
        _pvpCardMI.contentGetInstance = _cardMI.contentGetInstance;
        _pvpCardMI.contentGetName = _cardMI.contentGetName;
    } else {
        var contentClass = findClassByName("YgomGame.Card", "Content");
        if (contentClass) {
            var getInstance = findMethodByName(contentClass, "get_Instance", 0);
            var getNameMethod = findMethodByName(contentClass, "GetName", 2);
            var getDescMethod = findMethodByName(contentClass, "GetDesc", 2);
            if (getInstance && getNameMethod) {
                _pvpCardMI.contentGetInstance = getInstance;
                _pvpCardMI.contentGetName = getNameMethod;
                if (getDescMethod) _pvpCardMI.contentGetDesc = getDescMethod;
            }
        }
    }

    send("resolvePvpCardMethods: all PVP_ methods resolved");
    return true;
}

/**
 * Resolve PVP_ variants of command/dialog/list methods for online duels.
 * These are optional — if a PVP_ variant is not found, the caller falls back to DLL_/managed.
 */
function resolvePvpCommandMethods() {
    if (_pvpCmdMI) return _pvpCmdMI;

    var engineKlass = findEngineClass();
    if (!engineKlass) return null;

    var cache = {};

    // Command methods (all optional — store null if not found)
    var methods = [
        ["PVP_DuelComGetCommandMask", 3],
        ["PVP_DuelComGetMovablePhase", 0],
        ["PVP_ComDoCommand", 4],
        ["PVP_DuelDlgSetResult", 1],
        ["PVP_DuelListSendIndex", 1],
        // Input state methods
        ["PVP_IsSysActLoopExecute", 0],
        ["PVP_DuelDlgGetSelectItemNum", 0],
        ["PVP_DuelDlgCanYesNoSkip", 0],
        ["PVP_DuelDlgGetPosMaskOfThisSummon", 0],
        ["PVP_DuelListIsMultiMode", 0],
        ["PVP_DuelListGetSelectMax", 0],
        ["PVP_DuelListGetSelectMin", 0],
        ["PVP_DuelListGetItemMax", 0],
        ["PVP_DuelListGetItemID", 1],
        ["PVP_DuelListGetItemUniqueID", 1],
        ["PVP_DuelListGetItemFrom", 1],
        ["PVP_DuelDlgGetMixNum", 0]
    ];
    for (var i = 0; i < methods.length; i++) {
        cache[methods[i][0]] = findMethodByName(engineKlass, methods[i][0], methods[i][1]);
    }

    _pvpCmdMI = cache;
    send("resolvePvpCommandMethods: resolved " + Object.keys(cache).filter(function(k) { return cache[k] !== null; }).length + "/" + methods.length + " methods");
    return _pvpCmdMI;
}

/**
 * Get the active card method set based on duel mode.
 * Returns PVP_ methods for online duels, DLL_ for solo.
 */
function getActiveCardMI() {
    // Always resolve DLL_ methods as fallback (needed even in PVP mode)
    resolveCardMethods();
    if (isOnlineMode()) {
        if (!resolvePvpCardMethods()) return _cardMI;  // fall back to DLL_ if PVP_ fails
        return _pvpCardMI;
    }
    if (!_cardMI) return null;
    return _cardMI;
}

function resolveCardMethods() {
    if (_cardMI) return true;

    var domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    var engineKlass = findEngineClass();
    if (!engineKlass) { send("resolveCardMethods: Engine class not found"); return false; }

    var names = [
        "DLL_DuelGetCardNum",           // (int player, int locate) -> int
        "DLL_DuelGetCardUniqueID",      // (int player, int locate, int index) -> int
        "DLL_DuelGetCardFace",          // (int player, int locate, int index) -> int
        "DLL_DuelGetCardIDByUniqueID2"  // (int uniqueID) -> int
    ];
    var resolved = {};
    for (var i = 0; i < names.length; i++) {
        var mi = findMethodByName(engineKlass, names[i], -1);
        if (!mi) { send("resolveCardMethods: " + names[i] + " NOT FOUND"); return false; }
        resolved[names[i]] = mi;
    }
    send("resolveCardMethods: all " + names.length + " methods resolved");

    _cardMI = {
        getCardNum:    resolved["DLL_DuelGetCardNum"],
        getCardUID:    resolved["DLL_DuelGetCardUniqueID"],
        getCardFace:   resolved["DLL_DuelGetCardFace"],
        getCardIDByUID: resolved["DLL_DuelGetCardIDByUniqueID2"]
    };

    // Resolve card name + desc lookup via YgomGame.Card.Content singleton
    var contentClass = findClassByName("YgomGame.Card", "Content");
    if (contentClass) {
        var getInstance = findMethodByName(contentClass, "get_Instance", 0);
        var getNameMethod = findMethodByName(contentClass, "GetName", 2);
        var getDescMethod = findMethodByName(contentClass, "GetDesc", 2);
        if (getInstance && getNameMethod) {
            _cardMI.contentGetInstance = getInstance;
            _cardMI.contentGetName = getNameMethod;
            if (getDescMethod) _cardMI.contentGetDesc = getDescMethod;
            send("resolveCardMethods: Card.Content.GetName" + (getDescMethod ? "+GetDesc" : "") + " resolved");
        }
    }

    return true;
}

/** Call a static Engine P/Invoke method via il2cpp_runtime_invoke, return unboxed int. */
function callCardFn(methodInfo, args) {
    var result = invokeStatic(methodInfo, args);
    if (!result || result.isNull()) return 0;
    return result.add(0x10).readS32();
}

/** Get card name from Card.Content singleton. Returns string or null. */
var _contentInstance = null;
function getCardName(cardId, mi) {
    var activeMI = mi || _cardMI || _pvpCardMI;
    if (!activeMI || !activeMI.contentGetName) return null;
    try {
        if (!_contentInstance) {
            _contentInstance = invokeStatic(activeMI.contentGetInstance, []);
        }
        if (!_contentInstance || _contentInstance.isNull()) return null;
        // GetName(int cardId, int lang) — lang 0 = default/English
        var nameObj = invokeInstance(activeMI.contentGetName, _contentInstance,
            [boxInt32(cardId), boxInt32(0)]);
        return readIl2cppString(nameObj);
    } catch (e) {
        return null;
    }
}

/** Get card description from Card.Content singleton. Returns string or null. */
function getCardDesc(cardId, mi) {
    var activeMI = mi || _cardMI || _pvpCardMI;
    if (!activeMI || !activeMI.contentGetDesc) return null;
    try {
        if (!_contentInstance) {
            _contentInstance = invokeStatic(activeMI.contentGetInstance, []);
        }
        if (!_contentInstance || _contentInstance.isNull()) return null;
        // GetDesc(int cardId, int lang) — lang 0 = default/English
        var descObj = invokeInstance(activeMI.contentGetDesc, _contentInstance,
            [boxInt32(cardId), boxInt32(0)]);
        return readIl2cppString(descObj);
    } catch (e) {
        return null;
    }
}

/**
 * Query cards in a specific zone for a player using il2cpp_runtime_invoke.
 * Returns array of {cardId, name, uid, face, zone, index}.
 * zoneLabel is a short string for display (e.g. "M2" for monster zone 2).
 * mi: optional method info set to use (defaults to auto-detect via getActiveCardMI).
 */
function getCardsInZone(player, zoneVal, zoneLabel, mi) {
    var activeMI = mi || getActiveCardMI();
    if (!activeMI) return [];
    var cards = [];
    var useDllFallback = (_cardMI && activeMI !== _cardMI);
    try {
        var count = callCardFn(activeMI.getCardNum, [boxInt32(player), boxInt32(zoneVal)]);
        // Fallback: if PVP_ getCardNum returned 0, try DLL_ version
        if (count <= 0 && useDllFallback) {
            count = callCardFn(_cardMI.getCardNum, [boxInt32(player), boxInt32(zoneVal)]);
        }
        for (var i = 0; i < count && i < 20; i++) {
            var uid = callCardFn(activeMI.getCardUID, [boxInt32(player), boxInt32(zoneVal), boxInt32(i)]);
            // Fallback: if PVP_ getCardUID returned 0, try DLL_ version
            if (uid <= 0 && useDllFallback) {
                uid = callCardFn(_cardMI.getCardUID, [boxInt32(player), boxInt32(zoneVal), boxInt32(i)]);
            }
            var cardId = 0;
            var name = null;
            if (uid > 0) {
                cardId = callCardFn(activeMI.getCardIDByUID, [boxInt32(uid)]);
                // Fallback: if PVP_ method returned 0, try DLL_ version
                if (cardId <= 0 && useDllFallback) {
                    cardId = callCardFn(_cardMI.getCardIDByUID, [boxInt32(uid)]);
                }
                // Cache hit: use previously resolved cardId if current call returned 0
                if (cardId > 0) {
                    _uidCardIdCache[uid] = cardId;
                } else if (_uidCardIdCache[uid]) {
                    cardId = _uidCardIdCache[uid];
                }
                if (cardId > 0) name = getCardName(cardId, activeMI);
            }
            var face = callCardFn(activeMI.getCardFace, [boxInt32(player), boxInt32(zoneVal), boxInt32(i)]);
            // Fallback: if PVP_ getCardFace returned invalid, try DLL_ version
            if ((face === null || face === undefined) && useDllFallback) {
                face = callCardFn(_cardMI.getCardFace, [boxInt32(player), boxInt32(zoneVal), boxInt32(i)]);
            }
            var desc = (cardId > 0) ? getCardDesc(cardId, activeMI) : null;
            cards.push({ cardId: cardId, name: name, desc: desc, uid: uid, face: face, zone: zoneLabel, index: i });
        }
    } catch (e) {
        send("getCardsInZone error (zone=" + zoneVal + "): " + e.message);
    }
    return cards;
}

// ── IL2CPP class enumeration ──

function enumerateClasses(namespaceFilter) {
    const domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    const sizePtr = Memory.alloc(Process.pointerSize);
    const assemblies = il2cpp_domain_get_assemblies(domain, sizePtr);
    const asmCount = sizePtr.readUInt();
    const results = [];

    for (var i = 0; i < asmCount; i++) {
        var asm = assemblies.add(i * Process.pointerSize).readPointer();
        var image = il2cpp_assembly_get_image(asm);
        var classCount = il2cpp_image_get_class_count(image);

        for (var j = 0; j < classCount; j++) {
            var klass = il2cpp_image_get_class(image, j);
            var ns = readCStr(il2cpp_class_get_namespace(klass));

            if (namespaceFilter && !ns.startsWith(namespaceFilter)) continue;

            var className = readCStr(il2cpp_class_get_name(klass));

            // Enumerate methods
            var methods = [];
            var mIter = Memory.alloc(Process.pointerSize);
            mIter.writePointer(ptr(0));
            while (true) {
                var method = il2cpp_class_get_methods(klass, mIter);
                if (method.isNull()) break;
                var mInfo = {
                    name: readCStr(il2cpp_method_get_name(method)),
                    params: il2cpp_method_get_param_count(method)
                };
                if (il2cpp_method_get_flags) {
                    try {
                        var flags = il2cpp_method_get_flags(method, ptr(0));
                        mInfo.isStatic = !!(flags & METHOD_ATTRIBUTE_STATIC);
                    } catch (e) {}
                }
                methods.push(mInfo);
            }

            // Enumerate fields
            var fields = [];
            var fIter = Memory.alloc(Process.pointerSize);
            fIter.writePointer(ptr(0));
            while (true) {
                var field = il2cpp_class_get_fields(klass, fIter);
                if (field.isNull()) break;
                var fInfo = {
                    name: readCStr(il2cpp_field_get_name(field)),
                    offset: il2cpp_field_get_offset(field),
                    isLiteral: il2cpp_field_is_literal(field)
                };
                if (il2cpp_field_get_flags) {
                    try {
                        var fflags = il2cpp_field_get_flags(field);
                        fInfo.isStatic = !!(fflags & FIELD_ATTRIBUTE_STATIC);
                    } catch (e) {}
                }
                fields.push(fInfo);
            }

            results.push({
                namespace: ns,
                class: className,
                methods: methods,
                fields: fields
            });
        }
    }

    return results;
}

// ── In-game reveal hooks ──
// Hook the rendering layer so rival's hidden cards appear face-up in-game.
// Strategy:
// 1. Hook CardRoot.Update — set isFace=true on rival cards, call ValidateFlipTurn
//    to trigger the visual 3D model flip (not just the data flag).
// 2. Hook HandCardManager..ctor + Initialize to capture the instance, then
//    force farAllOpen=true so opponent's hand cards render face-up.

var _revealHooksInstalled = false;
var _revealHookListeners = [];

// Field offsets (from IL2CPP enumeration)
var CARDROOT_TEAM_OFFSET    = 0x90;  // <team>k__BackingField (int32)
var CARDROOT_ISFACE_OFFSET  = 0xa4;  // <isFace>k__BackingField (bool/byte)
var CARDROOT_ISATTACK_OFFSET = 0xa5; // <isAttack>k__BackingField (bool/byte)
var CARDROOT_CARDID_OFFSET  = 0x9c;  // <cardId>k__BackingField (int32)
var CARDROOT_PLANE_OFFSET   = 0x78;  // <cardPlane>k__BackingField (ptr)
var HANDMGR_FAR_ALLOPEN_OFFSET = 0x21; // <farAllOpen>k__BackingField (bool/byte)

var _capturedHandMgr = null;
var _flipTurnMethod = null;  // CardPlane.FlipTurn(bool,bool,bool,bool,Action)

// Pre-allocated boolean buffers for FlipTurn args
var _boolTrue = null;
var _boolFalse = null;
var _nullRef = null;

function installRevealHooks() {
    if (_revealHooksInstalled) return { success: true, status: "already_installed" };

    var domain = il2cpp_domain_get();
    il2cpp_thread_attach(domain);

    if (!_duelRivalFn) resolveNativeLP();

    // Pre-allocate param buffers
    _boolTrue = Memory.alloc(1);  _boolTrue.writeU8(1);
    _boolFalse = Memory.alloc(1); _boolFalse.writeU8(0);
    _nullRef = Memory.alloc(Process.pointerSize); _nullRef.writePointer(ptr(0));

    var hooked = [];

    // ---- Resolve CardPlane.FlipTurn ----
    var planeCls = findClassByName("YgomGame.Duel", "CardPlane");
    if (planeCls) {
        _flipTurnMethod = findMethodByName(planeCls, "FlipTurn", 5);
        send("[RevealHook] CardPlane.FlipTurn resolved: " + !!_flipTurnMethod);
    }

    // ---- Hook CardRoot.Update — call FlipTurn on rival's face-down cards ----
    var cardRootCls = findClassByName("YgomGame.Duel", "CardRoot");
    if (cardRootCls) {
        var updateMethod = findMethodByName(cardRootCls, "Update", 0);
        if (updateMethod) {
            var updateAddr = updateMethod.readPointer();
            var _logCount = 0;
            var _errCount = 0;
            var updateListener = Interceptor.attach(updateAddr, {
                onEnter: function (args) {
                    try {
                        var thisPtr = args[0];
                        if (thisPtr.isNull()) return;

                        var cardId = thisPtr.add(CARDROOT_CARDID_OFFSET).readS32();
                        if (cardId <= 0) return;

                        var team = thisPtr.add(CARDROOT_TEAM_OFFSET).readS32();
                        var rival = 1;
                        try { if (_duelRivalFn) rival = _duelRivalFn(ptr(0)); } catch (e) {}
                        if (rival < 0 || rival > 1) rival = 1;
                        if (team !== rival) return;

                        var isFace = thisPtr.add(CARDROOT_ISFACE_OFFSET).readU8();
                        if (isFace !== 0) return;

                        // Read current isAttack to preserve attack/defense position
                        var isAttack = thisPtr.add(CARDROOT_ISATTACK_OFFSET).readU8();
                        var isAttackBuf = isAttack ? _boolTrue : _boolFalse;

                        // Get CardPlane and call FlipTurn to visually flip the 3D model
                        var planePtr = thisPtr.add(CARDROOT_PLANE_OFFSET).readPointer();
                        if (planePtr.isNull()) {
                            if (_errCount < 3) { _errCount++; send("[RevealHook] planePtr null for cardId=" + cardId); }
                            return;
                        }

                        if (_flipTurnMethod && !planePtr.isNull()) {
                            // Safety: verify the object pointer looks valid before calling
                            try {
                                planePtr.readPointer(); // test read — will throw if invalid
                            } catch (_) {
                                // Invalid pointer, skip silently
                                return;
                            }
                            try {
                                invokeInstance(_flipTurnMethod, planePtr, [
                                    _boolTrue,    // isFace = true
                                    isAttackBuf,  // isAttack = preserve current
                                    _boolTrue,    // immediate = true (instant flip)
                                    _boolFalse,   // deckFlip = false
                                    _nullRef      // onFinished = null
                                ]);

                                _logCount++;
                                if (_logCount <= 10) {
                                    send("[RevealHook] FlipTurn OK cardId=" + cardId +
                                         " plane=" + planePtr + " atk=" + isAttack);
                                }
                            } catch (flipErr) {
                                _errCount++;
                                if (_errCount <= 3) {
                                    send("[RevealHook] FlipTurn skip cardId=" + cardId);
                                }
                            }
                        }
                    } catch (e) {
                        _errCount++;
                        if (_errCount <= 5) send("[RevealHook] outer error: " + e.message);
                    }
                }
            });
            _revealHookListeners.push(updateListener);
            hooked.push("CardRoot.Update");
            send("[RevealHook] CardRoot.Update hooked at " + updateAddr);
        }
    }

    // ---- Capture HandCardManager instance via multiple hooks ----
    var handMgrCls = findClassByName("YgomGame.Duel", "HandCardManager");
    if (handMgrCls) {
        // Hook .ctor to capture on creation
        var ctorMethod = findMethodByName(handMgrCls, ".ctor", 0);
        if (ctorMethod) {
            var ctorAddr = ctorMethod.readPointer();
            var ctorListener = Interceptor.attach(ctorAddr, {
                onEnter: function (args) { this._mgr = args[0]; },
                onLeave: function () {
                    try {
                        if (this._mgr && !this._mgr.isNull()) {
                            _capturedHandMgr = this._mgr;
                            _capturedHandMgr.add(HANDMGR_FAR_ALLOPEN_OFFSET).writeU8(1);
                            send("[RevealHook] HandCardManager captured via .ctor, farAllOpen=true");
                        }
                    } catch (e) {}
                }
            });
            _revealHookListeners.push(ctorListener);
            hooked.push("HandCardManager..ctor");
        }

        // Hook Initialize
        var initMethod = findMethodByName(handMgrCls, "Initialize", -1);
        if (initMethod) {
            var initAddr = initMethod.readPointer();
            var initListener = Interceptor.attach(initAddr, {
                onEnter: function (args) { _capturedHandMgr = args[0]; },
                onLeave: function () {
                    try {
                        if (_capturedHandMgr && !_capturedHandMgr.isNull()) {
                            _capturedHandMgr.add(HANDMGR_FAR_ALLOPEN_OFFSET).writeU8(1);
                            send("[RevealHook] HandCardManager.Initialize: farAllOpen=true");
                        }
                    } catch (e) {}
                }
            });
            _revealHookListeners.push(initListener);
            hooked.push("HandCardManager.Initialize");
        }

        // Hook AddFarHandCard + SyncFarHandInfo + SetFarHandInfo
        var handHookNames = ["AddFarHandCard", "SyncFarHandInfo", "SetFarHandInfo"];
        for (var hi = 0; hi < handHookNames.length; hi++) {
            var hm = findMethodByName(handMgrCls, handHookNames[hi], -1);
            if (hm) {
                var hAddr = hm.readPointer();
                (function (name) {
                    var _hLog = 0;
                    var listener = Interceptor.attach(hAddr, {
                        onEnter: function (args) {
                            try { _capturedHandMgr = args[0]; } catch (e) {}
                        },
                        onLeave: function () {
                            try {
                                if (_capturedHandMgr && !_capturedHandMgr.isNull()) {
                                    _capturedHandMgr.add(HANDMGR_FAR_ALLOPEN_OFFSET).writeU8(1);
                                    _hLog++;
                                    if (_hLog <= 3)
                                        send("[RevealHook] " + name + ": farAllOpen=true");
                                }
                            } catch (e) {}
                        }
                    });
                    _revealHookListeners.push(listener);
                    hooked.push("HandCardManager." + name);
                })(handHookNames[hi]);
            }
        }

        // Hook GetFarHandCardNum — called frequently to check hand size
        var getNumMethod = findMethodByName(handMgrCls, "GetFarHandCardNum", 0);
        if (getNumMethod) {
            var getNumAddr = getNumMethod.readPointer();
            var _numCaptured = false;
            var getNumListener = Interceptor.attach(getNumAddr, {
                onEnter: function (args) {
                    if (_numCaptured) return;
                    try {
                        _capturedHandMgr = args[0];
                        if (_capturedHandMgr && !_capturedHandMgr.isNull()) {
                            _capturedHandMgr.add(HANDMGR_FAR_ALLOPEN_OFFSET).writeU8(1);
                            _numCaptured = true;
                            send("[RevealHook] HandCardManager captured via GetFarHandCardNum, farAllOpen=true");
                        }
                    } catch (e) {}
                }
            });
            _revealHookListeners.push(getNumListener);
            hooked.push("HandCardManager.GetFarHandCardNum");
        }
    }

    if (hooked.length === 0) {
        return { success: false, error: "No rendering methods found to hook" };
    }

    _revealHooksInstalled = true;
    return { success: true, hooked: hooked };
}

function removeRevealHooks() {
    if (!_revealHooksInstalled) return { success: true, status: "not_installed" };

    for (var i = 0; i < _revealHookListeners.length; i++) {
        try {
            _revealHookListeners[i].detach();
        } catch (e) {
            send("[RevealHook] detach error: " + e.message);
        }
    }
    _revealHookListeners = [];
    _capturedHandMgr = null;
    _revealHooksInstalled = false;
    send("[RevealHook] hooks removed");
    return { success: true };
}

// ══════════════════════════════════════════
// RPC exports
// ══════════════════════════════════════════

rpc.exports = {
    ping: function () { return "pong"; },

    /**
     * Enumerate IL2CPP classes matching a namespace prefix.
     * Returns array of {namespace, class, methods: [{name, params, isStatic}], fields: [{name, offset, isStatic, isLiteral}]}
     */
    enumerate: function (namespaceFilter) {
        return enumerateClasses(namespaceFilter || "");
    },

    /**
     * Get current duel status: both players' LP, player identities.
     */
    status: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        // Check if Engine instance exists
        const engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        const inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No Engine instance (duel not active)" };

        var online = isOnlineMode();

        let myself = -1, rival = -1;
        try {
            if (_duelMyselfFn) myself = _duelMyselfFn(ptr(0));
            if (_duelRivalFn) rival = _duelRivalFn(ptr(0));
        } catch (e) {}

        var lp0 = 0, lp1 = 0, xorKey = 0;

        // Try PVP_ LP first
        resolvePvpCardMethods();
        if (_pvpTurnMI && _pvpTurnMI.getLP) {
            try {
                lp0 = callCardFn(_pvpTurnMI.getLP, [boxInt32(0)]);
                lp1 = callCardFn(_pvpTurnMI.getLP, [boxInt32(1)]);
            } catch (e) {}
            if (lp0 > 0 || lp1 > 0) {
                online = true;
                _isOnlineCache = true;
            }
        }

        // Fallback to native XOR (solo)
        if (lp0 === 0 && lp1 === 0 && resolveNativeLP()) {
            try {
                xorKey = readXorKey();
                const basePtr = readBasePtr();
                lp0 = xorKey ^ basePtr.readS32();
                lp1 = xorKey ^ basePtr.add(PLAYER_STRIDE).readS32();
            } catch (e) {}
        }

        return {
            myself: myself,
            rival: rival,
            lp: [lp0, lp1],
            xorKey: xorKey,
            online: online
        };
    },

    /**
     * Set a player's LP to a specific value by writing to XOR-obfuscated native memory.
     */
    setlp: function (player, value) {
        if (!resolveNativeLP()) return { error: "Not resolved" };

        const xorKey = readXorKey();
        const basePtr = readBasePtr();
        const newStored = xorKey ^ value;
        basePtr.add(player * PLAYER_STRIDE).writeS32(newStored);

        // Verify
        const readBack = xorKey ^ basePtr.add(player * PLAYER_STRIDE).readS32();
        return { player: player, target: value, readback: readBack };
    },

    /**
     * Instant win: set rival LP to 0.
     */
    win: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        if (!resolveNativeLP()) return { error: "Could not resolve native LP" };

        // Check Engine instance
        const engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        const inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };

        // Get rival index
        let rival = 1;
        try {
            if (_duelRivalFn) rival = _duelRivalFn(ptr(0));
        } catch (e) {}
        if (rival < 0 || rival > 1) rival = 1;

        // Read current LP
        const xorKey = readXorKey();
        const basePtr = readBasePtr();
        const lpBefore = xorKey ^ basePtr.add(rival * PLAYER_STRIDE).readS32();

        if (lpBefore <= 0) {
            return { status: "already_zero", rival: rival, lp: lpBefore };
        }

        // Write 0: stored = xorKey ^ 0 = xorKey
        basePtr.add(rival * PLAYER_STRIDE).writeS32(xorKey);

        // Verify
        const lpAfter = xorKey ^ basePtr.add(rival * PLAYER_STRIDE).readS32();

        return {
            status: lpAfter === 0 ? "success" : "failed",
            rival: rival,
            before: lpBefore,
            after: lpAfter
        };
    },

    /**
     * Check if a duel is currently active.
     */
    active: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);
        const engineKlass = findEngineClass();
        if (!engineKlass) { resetOnlineCache(); return false; }
        const inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) { resetOnlineCache(); return false; }
        return true;
    },

    /**
     * Diagnostic: check Engine state and enumerate PVP_/THREAD_ method variants.
     * Run this during a PvP duel to understand what's available.
     */
    diagpvp: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var result = { engineClassFound: false, sInstance: null, staticFields: [], pvpMethods: [], threadMethods: [], dllMethods: [] };

        var engineKlass = findEngineClass();
        if (!engineKlass) return result;
        result.engineClassFound = true;

        // Check s_instance
        var inst = getStaticFieldPtr(engineKlass, "s_instance");
        result.sInstance = inst ? ("0x" + inst.toString(16)) : "null";
        result.sInstanceIsNull = !inst || inst.isNull();

        // Enumerate all static fields and their values
        var fIter = Memory.alloc(Process.pointerSize);
        fIter.writePointer(ptr(0));
        while (true) {
            var field = il2cpp_class_get_fields(engineKlass, fIter);
            if (field.isNull()) break;
            var fname = il2cpp_field_get_name(field).readUtf8String();
            var foffset = il2cpp_field_get_offset(field);
            var isLiteral = il2cpp_field_is_literal(field);
            result.staticFields.push({ name: fname, offset: foffset, isLiteral: isLiteral });
        }

        // Enumerate all methods, categorize by prefix
        var mIter = Memory.alloc(Process.pointerSize);
        mIter.writePointer(ptr(0));
        while (true) {
            var method = il2cpp_class_get_methods(engineKlass, mIter);
            if (method.isNull()) break;
            var mname = il2cpp_method_get_name(method).readUtf8String();
            var paramCount = il2cpp_method_get_param_count(method);
            var entry = { name: mname, params: paramCount };
            if (mname.indexOf("PVP_") === 0) result.pvpMethods.push(entry);
            else if (mname.indexOf("THREAD_") === 0) result.threadMethods.push(entry);
            else if (mname.indexOf("DLL_Duel") === 0) result.dllMethods.push(entry);
        }

        return result;
    },

    // ══════════════════════════════════════════
    // Phase 2: Solo bot RPCs
    // ══════════════════════════════════════════

    /**
     * Inspect an IL2CPP method: returns full signature with param names, types, return type, isStatic.
     */
    inspect: function (namespace, className, methodName) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const klass = findClassByName(namespace, className);
        if (!klass) return { error: "Class not found: " + namespace + "." + className };

        // Find all overloads of this method
        const results = [];
        const iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));
        while (true) {
            const method = il2cpp_class_get_methods(klass, iter);
            if (method.isNull()) break;
            if (readCStr(il2cpp_method_get_name(method)) !== methodName) continue;

            const paramCount = il2cpp_method_get_param_count(method);
            const params = [];
            for (let p = 0; p < paramCount; p++) {
                const pName = readCStr(il2cpp_method_get_param_name(method, p));
                const pType = il2cpp_method_get_param(method, p);
                const pTypeName = readCStr(il2cpp_type_get_name(pType));
                params.push({ name: pName, type: pTypeName });
            }

            const retType = il2cpp_method_get_return_type(method);
            const retTypeName = readCStr(il2cpp_type_get_name(retType));

            let isStatic = false;
            if (il2cpp_method_get_flags) {
                try {
                    const flags = il2cpp_method_get_flags(method, ptr(0));
                    isStatic = !!(flags & METHOD_ATTRIBUTE_STATIC);
                } catch (e) {}
            }

            results.push({
                name: methodName,
                paramCount: paramCount,
                params: params,
                returnType: retTypeName,
                isStatic: isStatic
            });
        }

        if (results.length === 0) {
            return { error: "Method not found: " + methodName };
        }
        return { methods: results };
    },

    /**
     * Get duel finish/result state by calling Engine P/Invoke methods.
     * Returns {finish: int, result: int}. finish=0 means still playing.
     */
    getDuelResult: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        const inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };

        // Resolve DLL_DuelGetDuelFinish and DLL_DuelGetDuelResult
        // These are P/Invoke methods with 0 params, return int
        const finishAddr = getMethodAddr(engineKlass, "DLL_DuelGetDuelFinish");
        const resultAddr = getMethodAddr(engineKlass, "DLL_DuelGetDuelResult");

        if (!finishAddr) return { error: "DLL_DuelGetDuelFinish not found" };
        if (!resultAddr) return { error: "DLL_DuelGetDuelResult not found" };

        // These are parameterless P/Invoke stubs: () -> int
        // IL2CPP thunks take MethodInfo* as last param
        const finishFn = new NativeFunction(finishAddr, "int32", ["pointer"]);
        const resultFn = new NativeFunction(resultAddr, "int32", ["pointer"]);

        let finish = 0, result = 0;
        try {
            finish = finishFn(ptr(0));
        } catch (e) {
            return { error: "DuelGetDuelFinish call failed: " + e.message };
        }
        try {
            result = resultFn(ptr(0));
        } catch (e) {
            return { error: "DuelGetDuelResult call failed: " + e.message };
        }

        return { finish: finish, result: result };
    },

    /**
     * Call a static method on YgomSystem.Network.API with one optional int arg.
     * Polls the returned Handle for completion (up to 15 seconds).
     * Returns {success: bool, code: int, error: string|null}.
     */
    callApi: function (methodName, arg) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        // Find the API class
        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, code: -1, error: "API class not found" };

        // Find the method (most API methods take 1 param)
        const paramCount = (arg !== null && arg !== undefined) ? 1 : 0;
        var method = findMethodByName(apiClass, methodName, paramCount);
        if (!method) {
            // Try without param count filter
            method = findMethodByName(apiClass, methodName, -1);
            if (!method) return { success: false, code: -1, error: "Method not found: " + methodName };
        }

        // Invoke the API method
        var handleObj;
        try {
            var args = [];
            if (arg !== null && arg !== undefined) {
                args.push(boxInt32(arg));
            }
            handleObj = invokeStatic(method, args);
        } catch (e) {
            return { success: false, code: -1, error: "invoke failed: " + e.message };
        }

        if (!handleObj || handleObj.isNull()) {
            return { success: false, code: -1, error: "API returned null Handle" };
        }

        // Skip GC handles — use pointer directly
        try {
            return _pollHandle(handleObj);
        } catch (e) {
            return { success: false, code: -1, error: "poll failed: " + e.message };
        }
    },

    /**
     * Fire-and-forget: call API method without polling the Handle.
     * Returns {success: bool, error: string|null}.
     */
    callApiFireAndForget: function (methodName, arg) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, error: "API class not found" };

        var method = findMethodByName(apiClass, methodName, (arg !== null && arg !== undefined) ? 1 : 0);
        if (!method) {
            method = findMethodByName(apiClass, methodName, -1);
            if (!method) return { success: false, error: "Method not found: " + methodName };
        }

        try {
            var args = [];
            if (arg !== null && arg !== undefined) {
                args.push(boxInt32(arg));
            }
            invokeStatic(method, args);
            return { success: true, error: null };
        } catch (e) {
            return { success: false, error: "invoke failed: " + e.message };
        }
    },

    /**
     * List ViewControllerManager names in the namedManager dictionary.
     */
    listVcmNames: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const vcmClass = findClassByName("YgomSystem.UI", "ViewControllerManager");
        if (!vcmClass) return { error: "VCM class not found" };

        const dictObj = getStaticFieldPtr(vcmClass, "namedManager");
        if (!dictObj || dictObj.isNull()) return { error: "namedManager is null", names: [] };

        var entries = getDictEntries(dictObj);
        return { names: entries.map(function (e) { return e.key; }) };
    },

    /**
     * Call Solo_info and inspect the response to find gate/chapter IDs.
     * Returns {success, data} where data is the parsed GetParam() result.
     */
    getSoloInfo: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, error: "API class not found" };

        // Solo_info takes 1 bool param
        var method = findMethodByName(apiClass, "Solo_info", 1);
        if (!method) return { success: false, error: "Solo_info not found" };

        // Pre-resolve Handle class methods before invoking
        var handleClass = findClassByName("YgomSystem.Network", "Handle");
        if (!handleClass) return { success: false, error: "Handle class not found" };
        var isCompletedMethod = findMethodByName(handleClass, "IsCompleted", 0);
        var isErrorMethod = findMethodByName(handleClass, "IsError", 0);
        var getParamMethod = findMethodByName(handleClass, "GetParam", 0);
        if (!isCompletedMethod) return { success: false, error: "IsCompleted not found" };

        // Call Solo_info(false) — pass bool as int32(0)
        var handleObj;
        try {
            handleObj = invokeStatic(method, [boxInt32(0)]);
        } catch (e) {
            return { success: false, error: "invoke failed: " + e.message };
        }

        if (!handleObj || handleObj.isNull()) {
            return { success: false, error: "Solo_info returned null" };
        }

        send("getSoloInfo: invoke OK, handle=" + handleObj);

        // Skip GC handles — they crash in this IL2CPP build.
        // Use the pointer directly; the game holds its own reference
        // so GC won't collect it during our polling.
        try {
            // Poll for up to 30 seconds
            for (var i = 0; i < 300; i++) {
                var completed = false;
                try {
                    var completedResult = invokeInstance(isCompletedMethod, handleObj, []);
                    if (completedResult && !completedResult.isNull()) {
                        completed = !!completedResult.add(0x10).readU8();
                    }
                } catch (e) {
                    send("getSoloInfo: IsCompleted failed at poll " + i + ": " + e.message);
                    Thread.sleep(0.2);
                    continue;
                }

                if (completed) {
                    send("getSoloInfo: Handle completed at poll " + i);

                    // Check error
                    var isError = false;
                    try {
                        if (isErrorMethod) {
                            var errResult = invokeInstance(isErrorMethod, handleObj, []);
                            if (errResult && !errResult.isNull()) {
                                isError = !!errResult.add(0x10).readU8();
                            }
                        }
                    } catch (e) {
                        send("getSoloInfo: IsError check failed: " + e.message);
                    }

                    if (isError) {
                        return { success: false, error: "Solo_info returned error" };
                    }

                    // Read GetParam
                    if (!getParamMethod) {
                        return { success: true, data: null, note: "GetParam not found" };
                    }

                    var paramResult;
                    try {
                        paramResult = invokeInstance(getParamMethod, handleObj, []);
                    } catch (e) {
                        return { success: true, data: null, note: "GetParam failed: " + e.message };
                    }

                    if (!paramResult || paramResult.isNull()) {
                        return { success: true, data: null, note: "GetParam returned null" };
                    }

                    send("getSoloInfo: GetParam returned " + paramResult);

                    // Inspect the returned object
                    var data;
                    try {
                        data = readObjectValue(paramResult, 0);
                    } catch (e) {
                        return { success: true, data: { _error: "readObjectValue: " + e.message } };
                    }
                    return { success: true, data: data };
                }

                Thread.sleep(0.1);
            }

            return { success: false, error: "Solo_info poll timeout (30s)" };
        } catch (e) {
            return { success: false, error: "poll exception: " + e.message };
        }
    },

    /**
     * Call any Network API method, poll Handle, and read GetParam() result.
     * Returns {success, code, data, error}.
     */
    callApiWithResult: function (methodName, arg) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, error: "API class not found" };

        var paramCount = (arg !== null && arg !== undefined) ? 1 : 0;
        var method = findMethodByName(apiClass, methodName, paramCount);
        if (!method) {
            method = findMethodByName(apiClass, methodName, -1);
            if (!method) return { success: false, error: "Method not found: " + methodName };
        }

        var handleObj;
        try {
            var args = [];
            if (arg !== null && arg !== undefined) {
                args.push(boxInt32(arg));
            }
            handleObj = invokeStatic(method, args);
        } catch (e) {
            return { success: false, error: "invoke failed: " + e.message };
        }

        if (!handleObj || handleObj.isNull()) {
            return { success: false, error: "API returned null Handle" };
        }

        // Skip GC handles — use pointer directly (same fix as getSoloInfo)
        try {
            return _pollHandleWithParam(handleObj);
        } catch (e) {
            return { success: false, error: "poll failed: " + e.message };
        }
    },

    /**
     * Scan a range of chapter IDs via Solo_detail, return valid ones (code=0).
     * Returns {valid: [ids], scanned: count, errors: count}.
     */
    scanChapters: function (startId, endId) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { error: "API class not found" };

        var method = findMethodByName(apiClass, "Solo_detail", 1);
        if (!method) return { error: "Solo_detail not found" };

        var handleClass = findClassByName("YgomSystem.Network", "Handle");
        if (!handleClass) return { error: "Handle class not found" };
        var isCompletedMethod = findMethodByName(handleClass, "IsCompleted", 0);
        var getCodeMethod = findMethodByName(handleClass, "GetCode", 0);
        if (!isCompletedMethod || !getCodeMethod) return { error: "Handle methods not found" };

        var valid = [];
        var scanned = 0;
        var errors = 0;

        for (var id = startId; id <= endId; id++) {
            scanned++;
            try {
                var handleObj = invokeStatic(method, [boxInt32(id)]);
                if (!handleObj || handleObj.isNull()) { errors++; continue; }

                // Quick poll — Solo_detail completes fast
                var code = -1;
                for (var p = 0; p < 50; p++) {
                    try {
                        var cr = invokeInstance(isCompletedMethod, handleObj, []);
                        if (cr && !cr.isNull() && cr.add(0x10).readU8()) {
                            var codeR = invokeInstance(getCodeMethod, handleObj, []);
                            if (codeR && !codeR.isNull()) code = codeR.add(0x10).readS32();
                            break;
                        }
                    } catch (e) { break; }
                    Thread.sleep(0.05);
                }

                if (code === 0) {
                    valid.push(id);
                    send("scanChapters: valid chapter " + id);
                }
            } catch (e) {
                errors++;
            }
        }

        return { valid: valid, scanned: scanned, errors: errors };
    },

    /**
     * Call SoloSelectChapterViewController.RetryDuel(manager, swapTarget, chapterId, isRental).
     * Finds the ViewControllerManager and active ViewController automatically.
     * Returns {success: bool, error: string|null}.
     */
    retryDuel: function (chapterId, isRental) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        // Resolve classes/methods
        var klass = findClassByName("YgomGame.Solo", "SoloSelectChapterViewController");
        if (!klass) return { success: false, error: "SoloSelectChapterViewController not found" };
        var method = findMethodByName(klass, "RetryDuel", 4);
        if (!method) return { success: false, error: "RetryDuel method not found" };

        var cvcmClass = findClassByName("YgomGame.Menu", "ContentViewControllerManager");
        if (!cvcmClass) return { success: false, error: "ContentViewControllerManager class not found" };
        var getManager = findMethodByName(cvcmClass, "GetManager", 0);
        if (!getManager) return { success: false, error: "GetManager not found" };

        var baseVcmClass = findClassByName("YgomSystem.UI", "ViewControllerManager");
        if (!baseVcmClass) return { success: false, error: "ViewControllerManager not found" };
        var getTopVC = findMethodByName(baseVcmClass, "GetStackTopViewController", 0);
        if (!getTopVC) return { success: false, error: "GetStackTopViewController not found" };

        // SoloStartProductionViewController methods for diagnostics + force-start
        var sspvClass = findClassByName("YgomGame.Solo", "SoloStartProductionViewController");
        var sspvStartDuel = sspvClass ? findMethodByName(sspvClass, "StartDuel", 0) : null;

        // Install one-time hooks on SoloStartProductionVC lifecycle
        if (sspvClass && !this._sspvHooked) {
            this._sspvHooked = true;

            // Diagnostic hooks (lightweight — no Update, no SelectTurn which gets its own hook)
            var diagNames = ["OnCreatedView", "Init", "StartDuel", "Final"];
            for (var hi = 0; hi < diagNames.length; hi++) {
                var hm = findMethodByName(sspvClass, diagNames[hi], 0);
                if (hm) {
                    (function(name, addr) {
                        Interceptor.attach(addr, {
                            onEnter: function () { send("SSPV." + name + "() called"); }
                        });
                    })(diagNames[hi], hm.readPointer());
                    send("retryDuel: hooked SSPV." + diagNames[hi]);
                }
            }

            // REPLACE SelectTurn entirely — the original tries to show a UI dialog
            // which crashes because we're not on the Solo scene.
            // Our replacement just writes the fields directly:
            //   playerTurn (offset 0xE8) = 0 (Go First)
            //   step (offset 0xE0) += 2 (skip SelectTurn + WaitSelectTurn → Final)
            // IL2CPP native signature: void SelectTurn(this*, MethodInfo*)
            var selectTurnMethod = findMethodByName(sspvClass, "SelectTurn", 0);
            if (selectTurnMethod) {
                var selectTurnAddr = selectTurnMethod.readPointer();
                Interceptor.replace(selectTurnAddr, new NativeCallback(function (thisPtr, methodInfo) {
                    var currentStep = thisPtr.add(0xE0).readS32();
                    send("SSPV.SelectTurn() REPLACED: step=" + currentStep +
                         ", setting playerTurn=0, step=" + (currentStep + 2));
                    thisPtr.add(0xE8).writeS32(0);           // playerTurn = Go First
                    thisPtr.add(0xE0).writeS32(currentStep + 2);  // skip to Final
                }, 'void', ['pointer', 'pointer']));
                send("retryDuel: SelectTurn REPLACED (no UI, direct field write)");
            }
        }

        send("retryDuel: scheduling on main thread...");
        var _method = method, _getManager = getManager, _getTopVC = getTopVC;
        var _chapterId = chapterId, _isRental = isRental;
        var _sspvStartDuel = sspvStartDuel;

        try {
            var result = runOnMainThread(function () {
                var vcmInstance = invokeStatic(_getManager, []);
                if (!vcmInstance || vcmInstance.isNull())
                    return { success: false, error: "GetManager() null" };

                var topVC = invokeInstance(_getTopVC, vcmInstance, []);
                if (!topVC || topVC.isNull())
                    return { success: false, error: "Top VC null" };

                // Log topVC class
                var topVCName = "?";
                try {
                    var cls = il2cpp_object_get_class(topVC);
                    topVCName = readCStr(il2cpp_class_get_namespace(cls)) + "." +
                                readCStr(il2cpp_class_get_name(cls));
                    send("retryDuel[main]: topVC = " + topVCName);
                } catch (e) {}

                // If topVC is a stuck SSPV from a previous chapter, skip it
                // (cleanVcStack should have been called first, but handle gracefully)
                if (topVCName.indexOf("SoloStartProductionViewController") !== -1) {
                    send("retryDuel[main]: stuck SSPV detected, will proceed anyway");
                }

                send("retryDuel[main]: calling RetryDuel(chapter=" + _chapterId + ")");
                invokeStatic(_method, [vcmInstance, topVC, boxInt32(_chapterId), boxBool(_isRental || false)]);
                return { success: true, error: null };
            });
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Force reboot via CVCM.PrepareReboot + ExecuteReboot.
     * This will disconnect Frida — caller must reattach.
     */
    forceReboot: function () {
        try {
            var result = runOnMainThread(function () {
                var cvcmClass = findClassByName("YgomGame.Menu", "ContentViewControllerManager");
                if (!cvcmClass) return { success: false, error: "CVCM not found" };
                var getManager = findMethodByName(cvcmClass, "GetManager", 0);
                var prepReboot = findMethodByName(cvcmClass, "PrepareReboot", 0);
                var execReboot = findMethodByName(cvcmClass, "ExecuteReboot", 1);
                if (!getManager || !prepReboot || !execReboot)
                    return { success: false, error: "reboot methods not found" };
                var mgr = invokeStatic(getManager, []);
                if (!mgr || mgr.isNull()) return { success: false, error: "no manager" };
                send("forceReboot: PrepareReboot + ExecuteReboot...");
                invokeInstance(prepReboot, mgr, []);
                invokeInstance(execReboot, mgr, [boxBool(false)]);
                return { success: true };
            });
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Dismiss error dialogs and stuck VCs without rebooting.
     * Checks both DialogViewControllerManager (for error popups)
     * and ContentViewControllerManager (for stuck content VCs).
     * Returns {success, actions: [...]} or {success: false, error}.
     */
    dismissAllDialogs: function () {
        try {
            var result = runOnMainThread(function () {
                var actions = [];

                // 1. Dismiss dialogs on DialogViewControllerManager
                var dvcmClass = findClassByName("YgomGame.Menu", "DialogViewControllerManager");
                if (dvcmClass) {
                    var dvcmGetMgr = findMethodByName(dvcmClass, "GetManager", 0);
                    var dvcmOnBack = findMethodByName(dvcmClass, "OnBack", 0);
                    if (dvcmGetMgr && dvcmOnBack) {
                        var dvcm = invokeStatic(dvcmGetMgr, []);
                        if (dvcm && !dvcm.isNull()) {
                            // Call OnBack multiple times to dismiss stacked dialogs
                            for (var i = 0; i < 5; i++) {
                                try {
                                    invokeInstance(dvcmOnBack, dvcm, []);
                                    actions.push("DialogVCM.OnBack");
                                } catch (e) { break; }
                            }
                        }
                    }
                }

                // 2. Content VCs (stuck SSPVs etc.) are handled by cleanVcStack — not here
                // This avoids destroying gameObjects that are still referenced in viewStack

                send("dismissAllDialogs: " + JSON.stringify(actions));
                return { success: actions.length > 0, actions: actions };
            });
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Dismiss whatever ViewController is on top (call OnBack on it).
     * Also pops any SoloStartProductionVC stuck on the stack.
     * Returns {success, dismissed: className} or {success: false, error}.
     */
    dismissTopDialog: function () {
        try {
            var result = runOnMainThread(function () {
                var cvcmClass = findClassByName("YgomGame.Menu", "ContentViewControllerManager");
                var getManager = findMethodByName(cvcmClass, "GetManager", 0);
                var baseVcmClass = findClassByName("YgomSystem.UI", "ViewControllerManager");
                var getTopVC = findMethodByName(baseVcmClass, "GetStackTopViewController", 0);

                var vcm = invokeStatic(getManager, []);
                if (!vcm || vcm.isNull()) return { success: false, error: "no manager" };
                var topVC = invokeInstance(getTopVC, vcm, []);
                if (!topVC || topVC.isNull()) return { success: false, error: "no top VC" };

                var vcName = "?";
                try {
                    var cls = il2cpp_object_get_class(topVC);
                    vcName = readCStr(il2cpp_class_get_namespace(cls)) + "." +
                             readCStr(il2cpp_class_get_name(cls));
                } catch (e) {}

                send("dismissTopDialog: topVC = " + vcName);

                // Try calling OnBack on the top VC
                try {
                    var vcClass = il2cpp_object_get_class(topVC);
                    var onBack = findMethodByName(vcClass, "OnBack", 0);
                    if (onBack) {
                        invokeInstance(onBack, topVC, []);
                        send("dismissTopDialog: OnBack called on " + vcName);
                        return { success: true, dismissed: vcName };
                    }
                } catch (e) {}

                // Fallback: try PopViewController on the manager
                try {
                    var popMethod = findMethodByName(baseVcmClass, "PopViewController", 1);
                    if (popMethod) {
                        invokeInstance(popMethod, vcm, [topVC]);
                        send("dismissTopDialog: PopViewController on " + vcName);
                        return { success: true, dismissed: vcName, popped: true };
                    }
                } catch (e) {}

                return { success: false, error: "no dismiss method on " + vcName };
            });
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Complete a solo chapter via API calls:
     * Solo_set_use_deck_type → Solo_start → Duel_begin → Duel_end(res=1)
     * Returns {success, steps: [{name, code, error}], verified}
     */
    completeSoloChapter: function (chapterId, gateId) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var steps = [];
        var apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, error: "API class not found", steps: steps };

        // Helper to call an API method with int arg and poll
        function callApiInt(name, arg) {
            var paramCount = (arg !== null && arg !== undefined) ? 1 : 0;
            var method = findMethodByName(apiClass, name, paramCount);
            if (!method) {
                method = findMethodByName(apiClass, name, -1);
                if (!method) return { name: name, success: false, error: "method not found" };
            }
            try {
                var args = [];
                if (arg !== null && arg !== undefined) args.push(boxInt32(arg));
                var handleObj = invokeStatic(method, args);
                if (!handleObj || handleObj.isNull()) return { name: name, success: false, error: "null handle" };
                var result = _pollHandleWithParam(handleObj);
                result.name = name;
                return result;
            } catch (e) {
                return { name: name, success: false, error: e.message };
            }
        }

        // Helper to call an API method with dict arg and poll
        function callApiDict(name, dictObj) {
            var method = findMethodByName(apiClass, name, 1);
            if (!method) return { name: name, success: false, error: "method not found" };
            try {
                var handleObj = invokeStatic(method, [dictObj]);
                if (!handleObj || handleObj.isNull()) return { name: name, success: false, error: "null handle" };
                var result = _pollHandleWithParam(handleObj);
                result.name = name;
                return result;
            } catch (e) {
                return { name: name, success: false, error: e.message };
            }
        }

        // Step 1: Solo_set_use_deck_type(chapter_id, 1) — rental deck
        send("completeSolo: Solo_set_use_deck_type(" + chapterId + ", 1)");
        var setDeckMethod = findMethodByName(apiClass, "Solo_set_use_deck_type", 2);
        if (setDeckMethod) {
            try {
                var h = invokeStatic(setDeckMethod, [boxInt32(chapterId), boxInt32(1)]);
                if (h && !h.isNull()) {
                    var r = _pollHandleWithParam(h);
                    r.name = "Solo_set_use_deck_type";
                    steps.push(r);
                    send("completeSolo: set_deck_type code=" + r.code);
                }
            } catch (e) {
                steps.push({ name: "Solo_set_use_deck_type", success: false, error: e.message });
            }
        }
        Thread.sleep(1);

        // Step 2: Solo_start(chapter_id)
        send("completeSolo: Solo_start(" + chapterId + ")");
        var r2 = callApiInt("Solo_start", chapterId);
        steps.push(r2);
        send("completeSolo: Solo_start code=" + r2.code);
        if (!r2.success) return { success: false, error: "Solo_start failed: " + r2.error, steps: steps };
        Thread.sleep(1);

        // Step 3: Duel_begin — construct dictionary
        send("completeSolo: constructing Duel_begin dict...");
        try {
            var beginDict = createManagedDict([
                { key: createManagedString("GameMode"), value: boxInt32AsObject(9) },
                { key: createManagedString("chapter"), value: boxInt32AsObject(chapterId) }
            ]);
            if (!beginDict) {
                steps.push({ name: "Duel_begin", success: false, error: "failed to create dict" });
            } else {
                send("completeSolo: Duel_begin(dict)...");
                var r3 = callApiDict("Duel_begin", beginDict);
                steps.push(r3);
                send("completeSolo: Duel_begin code=" + r3.code + " data=" + JSON.stringify(r3.data));
            }
        } catch (e) {
            steps.push({ name: "Duel_begin", success: false, error: "dict error: " + e.message });
            send("completeSolo: Duel_begin ERROR: " + e.message);
        }
        Thread.sleep(5);  // Wait 5s to simulate minimum duel time

        // Step 4: Duel_end — fire-and-forget (handle may not complete via polling)
        send("completeSolo: constructing Duel_end dict...");
        try {
            var endDict = createManagedDict([
                { key: createManagedString("res"), value: boxInt32AsObject(1) },
                { key: createManagedString("turn"), value: boxInt32AsObject(1) },
                { key: createManagedString("GameMode"), value: boxInt32AsObject(9) },
                { key: createManagedString("chapter"), value: boxInt32AsObject(chapterId) }
            ]);
            if (!endDict) {
                steps.push({ name: "Duel_end", success: false, error: "failed to create dict" });
            } else {
                send("completeSolo: Duel_end (fire-and-forget)...");
                var duelEndMethod = findMethodByName(apiClass, "Duel_end", 1);
                if (!duelEndMethod) {
                    steps.push({ name: "Duel_end", success: false, error: "method not found" });
                } else {
                    invokeStatic(duelEndMethod, [endDict]);
                    steps.push({ name: "Duel_end", success: true, code: 0 });
                    send("completeSolo: Duel_end sent");
                }
            }
        } catch (e) {
            steps.push({ name: "Duel_end", success: false, error: "dict error: " + e.message });
            send("completeSolo: Duel_end ERROR: " + e.message);
        }
        Thread.sleep(3);  // Wait for server to process Duel_end

        // Step 5: Verify with Solo_detail
        send("completeSolo: verifying with Solo_detail...");
        var r5 = callApiInt("Solo_detail", chapterId);
        steps.push(r5);
        var verified = (r5.code !== 0); // code != 0 means chapter is no longer available = completed
        send("completeSolo: Solo_detail code=" + r5.code + " verified=" + verified);

        return {
            success: verified,
            verified: verified,
            detail_code: r5.code,
            steps: steps
        };
    },

    /**
     * Hook Duel_begin and Duel_end to intercept their Dictionary parameters.
     * Call this, then play a solo duel manually. The captured data will be
     * sent via Frida messages and stored in _interceptedCalls.
     */
    interceptDuelCalls: function () {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { error: "API class not found" };

        // Hook Duel_begin
        var duelBeginMethod = findMethodByName(apiClass, "Duel_begin", 1);
        if (duelBeginMethod) {
            var duelBeginAddr = duelBeginMethod.readPointer();
            send("Hooking Duel_begin at " + duelBeginAddr);
            Interceptor.attach(duelBeginAddr, {
                onEnter: function (args) {
                    // args[0] = Dictionary<string,object> _rule_
                    // args[1] = MethodInfo*
                    var dictObj = args[0];
                    send("=== Duel_begin CALLED ===");
                    try {
                        var data = readObjectValue(dictObj, 0);
                        send("Duel_begin _rule_ = " + JSON.stringify(data, null, 2));
                        _interceptedCalls.duel_begin = data;
                    } catch (e) {
                        send("Duel_begin read error: " + e.message);
                    }
                }
            });
        } else {
            send("Duel_begin method not found");
        }

        // Hook Duel_end
        var duelEndMethod = findMethodByName(apiClass, "Duel_end", 1);
        if (duelEndMethod) {
            var duelEndAddr = duelEndMethod.readPointer();
            send("Hooking Duel_end at " + duelEndAddr);
            Interceptor.attach(duelEndAddr, {
                onEnter: function (args) {
                    var dictObj = args[0];
                    send("=== Duel_end CALLED ===");
                    try {
                        var data = readObjectValue(dictObj, 0);
                        send("Duel_end _params_ = " + JSON.stringify(data, null, 2));
                        _interceptedCalls.duel_end = data;
                    } catch (e) {
                        send("Duel_end read error: " + e.message);
                    }
                }
            });
        } else {
            send("Duel_end method not found");
        }

        // Also hook Solo_start and Solo_set_use_deck_type for the full flow
        var soloStartMethod = findMethodByName(apiClass, "Solo_start", 1);
        if (soloStartMethod) {
            var soloStartAddr = soloStartMethod.readPointer();
            send("Hooking Solo_start at " + soloStartAddr);
            Interceptor.attach(soloStartAddr, {
                onEnter: function (args) {
                    // args[0] = Int32 _chapter_ (passed as pointer to int for value type)
                    try {
                        var chapterId = args[0].toInt32();
                        send("=== Solo_start(" + chapterId + ") CALLED ===");
                        _interceptedCalls.solo_start = chapterId;
                    } catch (e) {
                        send("Solo_start read: " + e.message);
                    }
                }
            });
        }

        var setDeckMethod = findMethodByName(apiClass, "Solo_set_use_deck_type", 2);
        if (setDeckMethod) {
            var setDeckAddr = setDeckMethod.readPointer();
            send("Hooking Solo_set_use_deck_type at " + setDeckAddr);
            Interceptor.attach(setDeckAddr, {
                onEnter: function (args) {
                    try {
                        send("=== Solo_set_use_deck_type(" + args[0].toInt32() + ", " + args[1].toInt32() + ") CALLED ===");
                        _interceptedCalls.set_deck_type = [args[0].toInt32(), args[1].toInt32()];
                    } catch (e) {
                        send("Solo_set_use_deck_type read: " + e.message);
                    }
                }
            });
        }

        var deckCheckMethod = findMethodByName(apiClass, "Solo_deck_check", 0);
        if (deckCheckMethod) {
            var deckCheckAddr = deckCheckMethod.readPointer();
            send("Hooking Solo_deck_check at " + deckCheckAddr);
            Interceptor.attach(deckCheckAddr, {
                onEnter: function () {
                    send("=== Solo_deck_check() CALLED ===");
                    _interceptedCalls.deck_check = true;
                }
            });
        }

        return { success: true, hooked: ["Duel_begin", "Duel_end", "Solo_start", "Solo_set_use_deck_type", "Solo_deck_check"] };
    },

    /**
     * Get captured intercept data from manual duel.
     */
    getInterceptedData: function () {
        return _interceptedCalls;
    },

    /**
     * Set UnityEngine.Time.timeScale to speed up or slow down animations.
     * scale=1.0 is normal, scale=10.0 is 10x faster.
     * Returns {success, scale, error}.
     */
    setTimeScale: function (scale) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var timeClass = findClassByName("UnityEngine", "Time");
        if (!timeClass) return { success: false, error: "UnityEngine.Time not found" };

        var setter = findMethodByName(timeClass, "set_timeScale", 1);
        if (!setter) return { success: false, error: "set_timeScale not found" };

        try {
            invokeStatic(setter, [boxFloat(scale)]);
            return { success: true, scale: scale, error: null };
        } catch (e) {
            return { success: false, error: "set_timeScale failed: " + e.message };
        }
    },

    /**
     * Call a Network API method with 2 int args and poll the Handle.
     * Used for Solo_set_use_deck_type(chapter_id, deck_type).
     * Returns {success, code, data, error}.
     */
    callApiTwoArgs: function (methodName, arg1, arg2) {
        const domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        const apiClass = findClassByName("YgomSystem.Network", "API");
        if (!apiClass) return { success: false, error: "API class not found" };

        var method = findMethodByName(apiClass, methodName, 2);
        if (!method) return { success: false, error: "Method not found: " + methodName + "(2)" };

        try {
            var handleObj = invokeStatic(method, [boxInt32(arg1), boxInt32(arg2)]);
            if (!handleObj || handleObj.isNull()) return { success: false, error: "null Handle" };
            return _pollHandle(handleObj);
        } catch (e) {
            return { success: false, error: "invoke failed: " + e.message };
        }
    },

    /**
     * Set DuelEndMessage.IsNextButtonClicked = true to auto-advance
     * past the win/lose screen without mouse interaction.
     * Returns {success, error}.
     */
    advanceDuelEnd: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var cls = findClassByName("YgomGame.Duel", "DuelEndMessage");
        if (!cls) return { success: false, error: "DuelEndMessage not found" };

        var setter = findMethodByName(cls, "set_IsNextButtonClicked", 1);
        if (!setter) return { success: false, error: "set_IsNextButtonClicked not found" };

        try {
            invokeStatic(setter, [boxBool(true)]);
            return { success: true, error: null };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Install Interceptor hooks on result/clear ViewControllers to auto-dismiss them.
     * Hooks:
     *  - SoloClearViewController.OnCreatedView → calls OnBack() after brief delay
     *  - DuelpassResultViewController.OnCreatedView → calls NotificationStackRemove()
     *
     * These hooks persist for the lifetime of the Frida session.
     * Call once after attaching; they fire automatically when result screens appear.
     * Returns {success, hooked: [...]}.
     */
    hookResultScreens: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);
        var hooked = [];

        // Ensure the main thread hook is set up so queued OnBack calls execute
        setupMainThreadHook();

        // ---- SoloClearViewController: auto-call OnBack() ----
        var clearCls = findClassByName("YgomGame.Solo", "SoloClearViewController");
        if (clearCls) {
            var clearOnCreated = findMethodByName(clearCls, "OnCreatedView", 0);
            var clearOnBack = findMethodByName(clearCls, "OnBack", 0);
            if (clearOnCreated && clearOnBack) {
                var clearAddr = clearOnCreated.readPointer();
                var _clearOnBack = clearOnBack;  // capture for closure
                Interceptor.attach(clearAddr, {
                    onEnter: function (args) {
                        this.inst = args[0];  // 'this' in IL2CPP = first arg
                    },
                    onLeave: function () {
                        var inst = this.inst;
                        var onBackRef = _clearOnBack;
                        // Schedule OnBack after a very short delay so animations start
                        setTimeout(function () {
                            try {
                                var d = il2cpp_domain_get();
                                il2cpp_thread_attach(d);
                                invokeInstance(onBackRef, inst, []);
                                send("[AutoAdv] SoloClearVC.OnBack called");
                            } catch (e) {
                                send("[AutoAdv] SoloClearVC.OnBack err: " + e.message);
                            }
                        }, 300);
                    }
                });
                hooked.push("SoloClearViewController.OnCreatedView");
            }
        }

        // ---- Helper: hook any VC's OnCreatedView -> auto OnBack ----
        // Uses onEnter only (onLeave can crash on IL2CPP methods).
        // Queues OnBack on the main thread via _mainThreadQueue.
        function hookVcOnBack(ns, className) {
            var cls = findClassByName(ns, className);
            if (!cls) return false;
            var onCreated = findMethodByName(cls, "OnCreatedView", 0);
            var onBack = findMethodByName(cls, "OnBack", 0);
            if (!onCreated || !onBack) return false;
            var addr = onCreated.readPointer();
            var _onBack = onBack;
            var _name = className;
            Interceptor.attach(addr, {
                onEnter: function (args) {
                    var inst = args[0];
                    var ref = _onBack;
                    var tag = _name;
                    send("[AutoAdv] " + tag + ".OnCreatedView — will queue OnBack");
                    // Delay 300ms to let VC fully initialize, then queue on main thread
                    setTimeout(function () {
                        _mainThreadQueue.push({
                            fn: function () {
                                invokeInstance(ref, inst, []);
                                send("[AutoAdv] " + tag + ".OnBack called (main thread)");
                                return tag + ".OnBack";
                            },
                            done: false, result: null, error: null
                        });
                    }, 300);
                }
            });
            hooked.push(className + ".OnCreatedView");
            return true;
        }

        // ---- CommonDialogViewController: dismiss generic dialogs ----
        hookVcOnBack("YgomGame.Menu", "CommonDialogViewController");

        // ---- NotificationViewController: has OnBack but no OnCreatedView ----
        // Hook NotificationStackEntry instead (called when VC becomes active)
        var notifCls = findClassByName("YgomGame.Menu", "NotificationViewController");
        if (notifCls) {
            var notifEntry = findMethodByName(notifCls, "NotificationStackEntry", 0);
            var notifOnBack = findMethodByName(notifCls, "OnBack", 0);
            if (notifEntry && notifOnBack) {
                var notifAddr = notifEntry.readPointer();
                var _notifOnBack = notifOnBack;
                Interceptor.attach(notifAddr, {
                    onEnter: function (args) {
                        var inst = args[0];
                        var ref = _notifOnBack;
                        send("[AutoAdv] NotificationVC.NotificationStackEntry — will queue OnBack");
                        setTimeout(function () {
                            _mainThreadQueue.push({
                                fn: function () {
                                    invokeInstance(ref, inst, []);
                                    send("[AutoAdv] NotificationVC.OnBack called (main thread)");
                                    return "NotifVC.OnBack";
                                },
                                done: false, result: null, error: null
                            });
                        }, 500);
                    }
                });
                hooked.push("NotificationViewController.NotificationStackEntry");
            }
        }

        // ---- DuelResultViewController_Solo: hook OnCreatedView ----
        // No OnBack; we set DuelEndMessage.IsNextButtonClicked again as fallback
        var drsCls = findClassByName("YgomGame.Menu", "DuelResultViewController_Solo");
        if (drsCls) {
            var drsOnCreated = findMethodByName(drsCls, "OnCreatedView", 0);
            if (drsOnCreated) {
                var drsAddr = drsOnCreated.readPointer();
                Interceptor.attach(drsAddr, {
                    onEnter: function () {
                        send("[AutoAdv] DuelResultVC_Solo appeared");
                        // Re-set IsNextButtonClicked as push-through
                        try {
                            var demCls = findClassByName("YgomGame.Duel", "DuelEndMessage");
                            if (demCls) {
                                var setter = findMethodByName(demCls, "set_IsNextButtonClicked", 1);
                                if (setter) invokeStatic(setter, [boxBool(true)]);
                            }
                        } catch (e) {}
                    }
                });
                hooked.push("DuelResultViewController_Solo.OnCreatedView");
            }
        }

        // ---- DuelpassResultViewController: monitor only (no OnBack) ----
        var dpCls = findClassByName("YgomGame.Duelpass", "DuelpassResultViewController");
        if (dpCls) {
            var dpOnCreated = findMethodByName(dpCls, "OnCreatedView", 0);
            if (dpOnCreated) {
                var dpAddr = dpOnCreated.readPointer();
                Interceptor.attach(dpAddr, {
                    onEnter: function () {
                        send("[AutoAdv] DuelpassResultVC appeared -- relying on timeScale");
                    }
                });
                hooked.push("DuelpassResultViewController.OnCreatedView (monitor)");
            }
        }

        return { success: true, hooked: hooked };
    },

    /**
     * Discover all ViewController-related classes and methods for Solo mode automation.
     *
     * Enumerates classes in key namespaces (YgomGame.Solo, YgomGame.Duel, YgomSystem.UI)
     * and also searches for Result, Transition, Scene classes plus Unity helpers.
     * Returns a JSON object with all discovered classes grouped by category.
     */
    discoverSoloMethods: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var sizePtr = Memory.alloc(Process.pointerSize);
        var assemblies = il2cpp_domain_get_assemblies(domain, sizePtr);
        var asmCount = sizePtr.readUInt();

        // Collect all classes in a single pass for efficiency
        var soloClasses = [];        // YgomGame.Solo.*
        var duelClasses = [];        // YgomGame.Duel.*
        var uiClasses = [];          // YgomSystem.UI.ViewControllerManager & ViewController
        var resultClasses = [];      // Any class with "Result" in name
        var transitionClasses = [];  // Any class with "Transition" or "Scene" in name
        var sceneManagerMethods = []; // UnityEngine.SceneManagement.SceneManager
        var eventSystemMethods = []; // UnityEngine.EventSystems.EventSystem

        function getMethodsForClass(klass) {
            var methods = [];
            var mIter = Memory.alloc(Process.pointerSize);
            mIter.writePointer(ptr(0));
            while (true) {
                var method = il2cpp_class_get_methods(klass, mIter);
                if (method.isNull()) break;
                var mName = readCStr(il2cpp_method_get_name(method));
                var paramCount = il2cpp_method_get_param_count(method);
                var isStatic = false;
                if (il2cpp_method_get_flags) {
                    try {
                        var flags = il2cpp_method_get_flags(method, ptr(0));
                        isStatic = !!(flags & METHOD_ATTRIBUTE_STATIC);
                    } catch (e) {}
                }
                methods.push({ name: mName, paramCount: paramCount, isStatic: isStatic });
            }
            return methods;
        }

        function classEntry(ns, name, klass) {
            return {
                namespace: ns,
                className: name,
                fullName: ns ? ns + "." + name : name,
                methods: getMethodsForClass(klass)
            };
        }

        for (var i = 0; i < asmCount; i++) {
            var asm = assemblies.add(i * Process.pointerSize).readPointer();
            var image = il2cpp_assembly_get_image(asm);
            var classCount = il2cpp_image_get_class_count(image);

            for (var j = 0; j < classCount; j++) {
                var klass = il2cpp_image_get_class(image, j);
                var ns = readCStr(il2cpp_class_get_namespace(klass));
                var name = readCStr(il2cpp_class_get_name(klass));

                // 1) YgomGame.Solo namespace
                if (ns === "YgomGame.Solo" || ns.indexOf("YgomGame.Solo.") === 0) {
                    soloClasses.push(classEntry(ns, name, klass));
                }

                // 2) YgomGame.Duel namespace
                if (ns === "YgomGame.Duel" || ns.indexOf("YgomGame.Duel.") === 0) {
                    duelClasses.push(classEntry(ns, name, klass));
                }

                // 3) YgomSystem.UI — only ViewControllerManager and ViewController
                if (ns === "YgomSystem.UI" &&
                    (name === "ViewControllerManager" || name === "ViewController")) {
                    uiClasses.push(classEntry(ns, name, klass));
                }

                // 4) Any class with "Result" in name (across all namespaces)
                if (name.indexOf("Result") >= 0) {
                    resultClasses.push(classEntry(ns, name, klass));
                }

                // 5) Any class with "Transition" or "Scene" in name
                if (name.indexOf("Transition") >= 0 || name.indexOf("Scene") >= 0) {
                    transitionClasses.push(classEntry(ns, name, klass));
                }

                // 6) UnityEngine.SceneManagement.SceneManager
                if (ns === "UnityEngine.SceneManagement" && name === "SceneManager") {
                    sceneManagerMethods = getMethodsForClass(klass);
                }

                // 7) UnityEngine.EventSystems.EventSystem
                if (ns === "UnityEngine.EventSystems" && name === "EventSystem") {
                    eventSystemMethods = getMethodsForClass(klass);
                }
            }
        }

        return {
            solo: soloClasses,
            duel: duelClasses,
            ui: uiClasses,
            result: resultClasses,
            transition: transitionClasses,
            sceneManager: sceneManagerMethods,
            eventSystem: eventSystemMethods,
            summary: {
                soloCount: soloClasses.length,
                duelCount: duelClasses.length,
                uiCount: uiClasses.length,
                resultCount: resultClasses.length,
                transitionCount: transitionClasses.length,
                sceneManagerMethodCount: sceneManagerMethods.length,
                eventSystemMethodCount: eventSystemMethods.length
            }
        };
    },

    /**
     * Clean the VC stack by removing stuck SoloStartProductionViewControllers.
     * Tries multiple strategies:
     *   1. Enumerate VCM methods and try pop/remove methods
     *   2. Find the internal VC stack (List field) and remove via RemoveAt
     *   3. SetActive(false) on the stuck VC's gameObject
     * Returns {success, action, topVC, discovery} or {success: false, error}.
     */
    cleanVcStack: function () {
        try {
            var result = runOnMainThread(function () {
                var cvcmClass = findClassByName("YgomGame.Menu", "ContentViewControllerManager");
                var baseVcmClass = findClassByName("YgomSystem.UI", "ViewControllerManager");
                if (!cvcmClass || !baseVcmClass) return { success: false, error: "classes not found" };

                var getManager = findMethodByName(cvcmClass, "GetManager", 0);
                var getTopVC = findMethodByName(baseVcmClass, "GetStackTopViewController", 0);
                if (!getManager || !getTopVC) return { success: false, error: "methods not found" };

                var mgr = invokeStatic(getManager, []);
                if (!mgr || mgr.isNull()) return { success: false, error: "no manager" };

                // Helper to get topVC name
                function getTopVCName() {
                    try {
                        var vc = invokeInstance(getTopVC, mgr, []);
                        if (!vc || vc.isNull()) return { vc: null, name: "(null)" };
                        var cls = il2cpp_object_get_class(vc);
                        var name = readCStr(il2cpp_class_get_name(cls));
                        return { vc: vc, name: name };
                    } catch (e) { return { vc: null, name: "(error)" }; }
                }

                var top = getTopVCName();
                // Check if top VC needs cleaning (anything except Home is stuck)
                var needsClean = top.name.indexOf("Home") === -1 &&
                                 top.name !== "(null)" && top.name !== "(error)";
                if (!needsClean) {
                    return { success: true, action: "already_clean", topVC: top.name };
                }

                send("cleanVcStack: stuck VC found (" + top.name + "), trying to remove...");

                // ── Strategy 1: Enumerate VCM methods, try pop/remove ──
                var vcmMethodNames = [];
                var mIter = Memory.alloc(Process.pointerSize);
                mIter.writePointer(ptr(0));
                while (true) {
                    var m = il2cpp_class_get_methods(baseVcmClass, mIter);
                    if (m.isNull()) break;
                    var mName = readCStr(il2cpp_method_get_name(m));
                    var mParams = il2cpp_method_get_param_count(m);
                    vcmMethodNames.push(mName + "(" + mParams + ")");
                }
                var cvcmMethodNames = [];
                mIter.writePointer(ptr(0));
                while (true) {
                    var m = il2cpp_class_get_methods(cvcmClass, mIter);
                    if (m.isNull()) break;
                    var mName = readCStr(il2cpp_method_get_name(m));
                    var mParams = il2cpp_method_get_param_count(m);
                    cvcmMethodNames.push(mName + "(" + mParams + ")");
                }
                send("cleanVcStack VCM methods: " + vcmMethodNames.join(", "));
                send("cleanVcStack CVCM methods: " + cvcmMethodNames.join(", "));

                // Try known pop/remove method names
                var popNames = ["PopChildViewController", "PopTopViewController",
                                "RemoveTopViewController", "PopStack", "Pop",
                                "RemoveChildViewController", "DestroyTopViewController"];
                for (var pi = 0; pi < popNames.length; pi++) {
                    var pm = findMethodByName(baseVcmClass, popNames[pi], 0);
                    if (!pm) pm = findMethodByName(cvcmClass, popNames[pi], 0);
                    if (!pm) pm = findMethodByName(baseVcmClass, popNames[pi], 1);
                    if (!pm) pm = findMethodByName(cvcmClass, popNames[pi], 1);
                    if (pm) {
                        send("cleanVcStack: found " + popNames[pi] + ", trying...");
                        try {
                            var pc = il2cpp_method_get_param_count(pm);
                            if (pc === 0) invokeInstance(pm, mgr, []);
                            else invokeInstance(pm, mgr, [top.vc]); // pass the VC
                            top = getTopVCName();
                            if (top.name.indexOf("Home") !== -1 || top.name === "(null)") {
                                return { success: true, action: popNames[pi], topVC: top.name };
                            }
                        } catch (e) {
                            send("cleanVcStack: " + popNames[pi] + " failed: " + e.message);
                        }
                    }
                }

                // ── Strategy 2: Find internal VC stack List and RemoveAt ──
                send("cleanVcStack: discovering VCM fields...");
                var vcmFields = [];
                var fIter = Memory.alloc(Process.pointerSize);
                fIter.writePointer(ptr(0));
                while (true) {
                    var field = il2cpp_class_get_fields(baseVcmClass, fIter);
                    if (field.isNull()) break;
                    var fname = readCStr(il2cpp_field_get_name(field));
                    var foffset = il2cpp_field_get_offset(field);
                    var isLiteral = il2cpp_field_is_literal(field);
                    if (!isLiteral) vcmFields.push({ name: fname, offset: foffset });
                }
                send("cleanVcStack VCM fields: " + JSON.stringify(vcmFields));

                // Target the viewStack field directly (offset 0x48, discovered above)
                var viewStackOffset = -1;
                for (var fi = 0; fi < vcmFields.length; fi++) {
                    if (vcmFields[fi].name === "viewStack") {
                        viewStackOffset = vcmFields[fi].offset;
                        break;
                    }
                }

                if (viewStackOffset >= 0) {
                    try {
                        var listObj = mgr.add(viewStackOffset).readPointer();
                        if (!listObj.isNull()) {
                            var listCls = il2cpp_object_get_class(listObj);
                            var getCount = findMethodByName(listCls, "get_Count", 0);
                            var removeAt = findMethodByName(listCls, "RemoveAt", 1);

                            if (getCount && removeAt) {
                                var countObj = invokeInstance(getCount, listObj, []);
                                var count = countObj ? countObj.add(0x10).readS32() : 0;
                                send("cleanVcStack: viewStack count=" + count);

                                // Read _items array to inspect each entry
                                var fIter2 = Memory.alloc(Process.pointerSize);
                                fIter2.writePointer(ptr(0));
                                var itemsField = null;
                                while (true) {
                                    var f2 = il2cpp_class_get_fields(listCls, fIter2);
                                    if (f2.isNull()) break;
                                    if (readCStr(il2cpp_field_get_name(f2)) === "_items") {
                                        itemsField = f2;
                                        break;
                                    }
                                }

                                if (itemsField && count > 0) {
                                    var itemsOffset = il2cpp_field_get_offset(itemsField);
                                    var itemsArr = listObj.add(itemsOffset).readPointer();
                                    var removed = 0;

                                    // Iterate from end to start (remove from top first)
                                    for (var idx = count - 1; idx >= 0; idx--) {
                                        var itemPtr = itemsArr.add(0x20 + idx * Process.pointerSize).readPointer();
                                        if (itemPtr.isNull()) continue;
                                        var itemName = "?";
                                        try {
                                            var itemCls = il2cpp_object_get_class(itemPtr);
                                            itemName = readCStr(il2cpp_class_get_name(itemCls));
                                        } catch (e) { itemName = "(destroyed)"; }

                                        send("cleanVcStack: viewStack[" + idx + "] = " + itemName);

                                        // Remove non-Home VCs (SSPV, DuelResult, SoloClear, etc.)
                                        if (itemName.indexOf("Home") === -1) {
                                            invokeInstance(removeAt, listObj, [boxInt32(idx)]);
                                            send("cleanVcStack: removed " + itemName + " at index " + idx);
                                            removed++;
                                        }
                                    }

                                    if (removed > 0) {
                                        top = getTopVCName();
                                        return { success: true, action: "removeSSPV(" + removed + ")", topVC: top.name };
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        send("cleanVcStack: viewStack manipulation failed: " + e.message);
                    }
                }

                // ── Strategy 3: SetActive(false) on gameObject ──
                send("cleanVcStack: trying SetActive(false)...");
                try {
                    var compCls = findClassByName("UnityEngine", "Component");
                    var getGO = findMethodByName(compCls, "get_gameObject", 0);
                    var goCls = findClassByName("UnityEngine", "GameObject");
                    var setActive = findMethodByName(goCls, "SetActive", 1);
                    if (getGO && setActive && top.vc) {
                        var go = invokeInstance(getGO, top.vc, []);
                        if (go && !go.isNull()) {
                            invokeInstance(setActive, go, [boxBool(false)]);
                            send("cleanVcStack: SetActive(false) done");
                            top = getTopVCName();
                            return { success: top.name.indexOf("SoloStartProduction") === -1,
                                     action: "setActive(false)", topVC: top.name };
                        }
                    }
                } catch (e) {
                    send("cleanVcStack: SetActive failed: " + e.message);
                }

                return {
                    success: false, error: "all strategies failed", topVC: top.name,
                    vcmMethods: vcmMethodNames, cvcmMethods: cvcmMethodNames,
                    vcmFields: vcmFields.map(function(f) { return f.name + "@0x" + f.offset.toString(16); })
                };
            });
            return result;
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    /**
     * Read all solo gate & chapter data from ClientWork (local, no server calls).
     * Returns {gates: {gateId: {chapters: [...], ...}}, gateIds: [int], allChapters: [int]}
     */
    getSoloMasterData: function () {
        try {
            var domain = il2cpp_domain_get();
            il2cpp_thread_attach(domain);

            var cwuClass = findClassByName("YgomSystem.Utility", "ClientWorkUtil");
            if (!cwuClass) return { error: "ClientWorkUtil not found" };

            // GetMasterSoloGate() -> Dictionary<string, object>
            var getGate = findMethodByName(cwuClass, "GetMasterSoloGate", 0);
            if (!getGate) return { error: "GetMasterSoloGate not found" };

            var gateDict = invokeStatic(getGate, []);
            if (!gateDict || gateDict.isNull()) return { error: "GetMasterSoloGate returned null" };

            var gateData = readObjectValue(gateDict, 0);

            // Extract gate IDs from the dictionary keys
            var gateIds = [];
            if (gateData && gateData.entries) {
                var keys = Object.keys(gateData.entries);
                for (var i = 0; i < keys.length; i++) {
                    var k = parseInt(keys[i]);
                    if (!isNaN(k)) gateIds.push(k);
                }
            }
            gateIds.sort(function(a, b) { return a - b; });

            // For each gate, get chapters via GetMasterSoloChapter(gateID)
            var getChapter = findMethodByName(cwuClass, "GetMasterSoloChapter", 1);
            var allChapters = [];
            var gateChapters = {};
            var rawSample = null;

            if (getChapter) {
                for (var gi = 0; gi < gateIds.length; gi++) {
                    var gid = gateIds[gi];
                    try {
                        var chapterDict = invokeStatic(getChapter, [boxInt32(gid)]);
                        if (chapterDict && !chapterDict.isNull()) {
                            var chData = readObjectValue(chapterDict, 0);
                            // Store raw data for first gate for inspection
                            if (gi === 0) rawSample = chData;
                            var chapterIds = [];
                            if (chData && chData.entries) {
                                var ckeys = Object.keys(chData.entries);
                                for (var ci = 0; ci < ckeys.length; ci++) {
                                    var cid = parseInt(ckeys[ci]);
                                    if (!isNaN(cid)) {
                                        chapterIds.push(cid);
                                        allChapters.push(cid);
                                    }
                                }
                            }
                            chapterIds.sort(function(a, b) { return a - b; });
                            gateChapters[gid] = chapterIds;
                        }
                    } catch (e) {
                        send("getSoloMasterData: gate " + gid + " error: " + e.message);
                    }
                }
            }

            allChapters.sort(function(a, b) { return a - b; });

            return {
                gateIds: gateIds,
                gateCount: gateIds.length,
                gateChapters: gateChapters,
                allChapters: allChapters,
                totalChapters: allChapters.length,
                rawSample: rawSample
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    /**
     * Install/remove Interceptor hooks so rival's hidden cards appear face-up in-game.
     * enable=true installs hooks, enable=false removes them.
     */
    hookreveal: function (enable) {
        if (enable) {
            return installRevealHooks();
        } else {
            return removeRevealHooks();
        }
    },

    /**
     * Reveal opponent's hand cards and face-down cards on the field.
     * Uses Master Duel zone constants (sequential IDs, not bitmask):
     *   z1-z5: Monster zones, z6-z10: Spell/Trap zones,
     *   z11-z12: Extra Monster zones, z13: Hand
     */
    reveal: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        var inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };

        if (!resolveCardMethods()) return { error: "Could not resolve card methods" };
        resolveNativeLP();

        var rival = 1;
        try {
            if (_duelRivalFn) rival = _duelRivalFn(ptr(0));
        } catch (e) {}
        if (rival < 0 || rival > 1) rival = 1;

        // Query rival's HAND (zone 13)
        var handCards = getCardsInZone(rival, ZONE_HAND, "H");
        var hand = [];
        for (var i = 0; i < handCards.length; i++) {
            var c = handCards[i];
            hand.push({ id: c.cardId, name: c.name });
        }

        // Query rival's field zones for face-down cards
        var facedown = [];

        // Monster zones (z1-z5) + Extra Monster zones (z11-z12)
        for (var z = ZONE_MONSTER_START; z <= ZONE_MONSTER_END; z++) {
            var cards = getCardsInZone(rival, z, "M" + z);
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].face === 0) {
                    facedown.push({ id: cards[i].cardId, name: cards[i].name,
                                    zone: "M", index: z });
                }
            }
        }
        // Extra monster zones
        for (var z = ZONE_EXTRA_MONSTER_1; z <= ZONE_EXTRA_MONSTER_2; z++) {
            var cards = getCardsInZone(rival, z, "EM" + (z - ZONE_EXTRA_MONSTER_1 + 1));
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].face === 0) {
                    facedown.push({ id: cards[i].cardId, name: cards[i].name,
                                    zone: "EM", index: z - ZONE_EXTRA_MONSTER_1 + 1 });
                }
            }
        }

        // Spell/Trap zones (z6-z10)
        for (var z = ZONE_SPELL_START; z <= ZONE_SPELL_END; z++) {
            var cards = getCardsInZone(rival, z, "S" + (z - ZONE_SPELL_START + 1));
            for (var i = 0; i < cards.length; i++) {
                if (cards[i].face === 0) {
                    facedown.push({ id: cards[i].cardId, name: cards[i].name,
                                    zone: "S", index: z - ZONE_SPELL_START + 1 });
                }
            }
        }

        return { hand: hand, facedown: facedown };
    },

    /**
     * Deep diagnostic: game state, zone scan, list approach, search functions.
     */
    zonescan: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        var inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };
        if (!resolveCardMethods()) return { error: "Could not resolve card methods" };
        resolveNativeLP();

        var myself = 0, rival = 1;
        try {
            if (_duelRivalFn) rival = _duelRivalFn(ptr(0));
            if (_duelMyselfFn) myself = _duelMyselfFn(ptr(0));
        } catch (e) {}

        // Resolve additional diagnostic methods
        var whichTurn = findMethodByName(engineKlass, "DLL_DuelWhichTurnNow", -1);
        var getPhase = findMethodByName(engineKlass, "DLL_DuelGetCurrentPhase", -1);
        var getTurnNum = findMethodByName(engineKlass, "DLL_DuelGetTurnNum", -1);
        var getHandOpen = findMethodByName(engineKlass, "DLL_DuelGetHandCardOpen", -1);
        var searchByUID = findMethodByName(engineKlass, "DLL_DuelSearchCardByUniqueID", -1);
        var getCardInHand = findMethodByName(engineKlass, "DLL_DuelGetCardInHand", -1);
        var listGetMax = findMethodByName(engineKlass, "DLL_DuelListGetItemMax", -1);
        var listGetID = findMethodByName(engineKlass, "DLL_DuelListGetItemID", -1);
        var listGetUID = findMethodByName(engineKlass, "DLL_DuelListGetItemUniqueID", -1);
        var getCardProp = findMethodByName(engineKlass, "DLL_DuelGetCardPropByUniqueID", -1);
        var isCardExist = findMethodByName(engineKlass, "DLL_DuelIsThisCardExist", -1);
        var topCard = findMethodByName(engineKlass, "DLL_DuelGetTopCardIndex", -1);
        var getDuelFinish = findMethodByName(engineKlass, "DLL_DuelGetDuelFinish", -1);

        var results = { myself: myself, rival: rival };

        // Game state
        try {
            if (whichTurn) results.whichTurn = callCardFn(whichTurn, []);
            if (getPhase) results.phase = callCardFn(getPhase, []);
            if (getTurnNum) results.turnNum = callCardFn(getTurnNum, []);
            if (getDuelFinish) results.duelFinish = callCardFn(getDuelFinish, []);
        } catch(e) { results.stateError = e.message; }

        // Zone scan: test ALL values 0-70 to find every zone
        results.zones = {};
        var testVals = [];
        for (var v = 0; v <= 70; v++) testVals.push(v);

        for (var p = 0; p <= 1; p++) {
            var pLabel = "p" + p + (p === myself ? "_ME" : "_RIVAL");
            var pData = {};
            for (var ti = 0; ti < testVals.length; ti++) {
                var zv = testVals[ti];
                try {
                    var count = callCardFn(_cardMI.getCardNum,
                        [boxInt32(p), boxInt32(zv)]);
                    if (count > 0 && count < 100) {
                        var cards = [];
                        for (var i = 0; i < count && i < 15; i++) {
                            var uid = callCardFn(_cardMI.getCardUID,
                                [boxInt32(p), boxInt32(zv), boxInt32(i)]);
                            var face = callCardFn(_cardMI.getCardFace,
                                [boxInt32(p), boxInt32(zv), boxInt32(i)]);
                            var cardId = 0, name = null;
                            if (uid > 0) {
                                cardId = callCardFn(_cardMI.getCardIDByUID, [boxInt32(uid)]);
                                if (cardId > 0) name = getCardName(cardId);
                            }
                            cards.push({i:i, uid:uid, cid:cardId, name:name, face:face});
                        }
                        pData["z" + zv] = {count:count, cards:cards};
                    }
                } catch (e) {}
            }
            results.zones[pLabel] = pData;
        }

        // List-based hand approach
        results.listHand = {};
        if (getCardInHand && listGetMax && listGetID) {
            for (var p = 0; p <= 1; p++) {
                try {
                    callCardFn(getCardInHand, [boxInt32(p)]);
                    var max = callCardFn(listGetMax, []);
                    var items = [];
                    for (var i = 0; i < max && i < 15; i++) {
                        var cid = callCardFn(listGetID, [boxInt32(i)]);
                        var uid = listGetUID ? callCardFn(listGetUID, [boxInt32(i)]) : -1;
                        var nm = getCardName(cid);
                        items.push({cid:cid, uid:uid, name:nm});
                    }
                    results.listHand["p"+p] = {max:max, items:items};
                } catch(e) {
                    results.listHand["p"+p] = {error:e.message};
                }
            }
        }

        // Search known UIDs
        if (searchByUID) {
            results.searchUID = {};
            var knownUIDs = [1,2,3,4,5,6,7,8,9,10,23];
            for (var ui = 0; ui < knownUIDs.length; ui++) {
                try {
                    var r = callCardFn(searchByUID, [boxInt32(knownUIDs[ui])]);
                    if (r !== 0) results.searchUID["uid" + knownUIDs[ui]] = r;
                } catch(e) {}
            }
        }

        // HandCardOpen
        if (getHandOpen) {
            results.handOpen = {};
            for (var p = 0; p <= 1; p++) {
                var opens = [];
                for (var i = 0; i < 10; i++) {
                    try {
                        var r = callCardFn(getHandOpen, [boxInt32(p), boxInt32(i)]);
                        opens.push(r);
                    } catch(e) { break; }
                }
                results.handOpen["p"+p] = opens;
            }
        }

        // IsThisCardExist for various zones
        if (isCardExist) {
            results.cardExist = {};
            for (var p = 0; p <= 1; p++) {
                var exists = {};
                for (var ti = 0; ti < testVals.length; ti++) {
                    var zv = testVals[ti];
                    try {
                        var r = callCardFn(isCardExist, [boxInt32(p), boxInt32(zv)]);
                        if (r !== 0) exists["z" + zv] = r;
                    } catch(e) {}
                }
                if (Object.keys(exists).length > 0) results.cardExist["p"+p] = exists;
            }
        }

        // TopCardIndex
        if (topCard) {
            results.topCard = {};
            for (var p = 0; p <= 1; p++) {
                var tops = {};
                for (var zv = 0; zv <= 8; zv++) {
                    try {
                        var r = callCardFn(topCard, [boxInt32(p), boxInt32(zv)]);
                        if (r !== 0 && r !== -1) tops["z" + zv] = r;
                    } catch(e) {}
                }
                if (Object.keys(tops).length > 0) results.topCard["p"+p] = tops;
            }
        }

        return results;
    },

    /**
     * Enumerate all methods on YgomGame.Duel.Engine class.
     * Optionally filter by prefix (default: "DLL_DuelCom" to find action methods).
     * Returns {methods: [{name, paramCount, params: [{name, type}], returnType, isStatic}]}.
     */
    enumEngine: function (prefix) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var filter = (prefix !== undefined && prefix !== null) ? prefix : "DLL_DuelCom";
        var methods = [];
        var iter = Memory.alloc(Process.pointerSize);
        iter.writePointer(ptr(0));

        while (true) {
            var method = il2cpp_class_get_methods(engineKlass, iter);
            if (method.isNull()) break;

            var mName = readCStr(il2cpp_method_get_name(method));
            if (filter && mName.indexOf(filter) !== 0) continue;

            var paramCount = il2cpp_method_get_param_count(method);
            var params = [];
            for (var p = 0; p < paramCount; p++) {
                var pName = readCStr(il2cpp_method_get_param_name(method, p));
                var pType = il2cpp_method_get_param(method, p);
                var pTypeName = readCStr(il2cpp_type_get_name(pType));
                params.push({ name: pName, type: pTypeName });
            }

            var retType = il2cpp_method_get_return_type(method);
            var retTypeName = readCStr(il2cpp_type_get_name(retType));

            var isStatic = false;
            if (il2cpp_method_get_flags) {
                try {
                    var flags = il2cpp_method_get_flags(method, ptr(0));
                    isStatic = !!(flags & METHOD_ATTRIBUTE_STATIC);
                } catch (e) {}
            }

            methods.push({
                name: mName,
                paramCount: paramCount,
                params: params,
                returnType: retTypeName,
                isStatic: isStatic
            });
        }

        return { methods: methods, count: methods.length, filter: filter };
    },

    /**
     * Get complete game state snapshot for autopilot decision-making.
     * Returns {myself, rival, myLP, rivalLP, turnPlayer, phase, turnNum,
     *          myHand, rivalHand, myField, rivalField, myGY, rivalGY, myDeck, rivalDeck}.
     */
    gameState: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        var inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };

        var online = isOnlineMode();

        // Resolve card methods (try both sets)
        resolveCardMethods();
        resolvePvpCardMethods();

        var myself = 0, rival = 1;
        if (online) {
            // In PvP, detect correct player index by cross-referencing
            // DLL_ (engine: always "us" = 0) with PVP_ card counts
            var detected = detectPvpMyselfIndex();
            if (detected >= 0) {
                myself = detected;
                rival = detected === 0 ? 1 : 0;
            }
        } else {
            try {
                if (_duelMyselfFn) myself = _duelMyselfFn(ptr(0));
                if (_duelRivalFn) rival = _duelRivalFn(ptr(0));
            } catch (e) {}
        }
        if (myself < 0 || myself > 1) myself = 0;
        if (rival < 0 || rival > 1) rival = 1;

        // LP — try PVP_ first if online, then native XOR, then DLL_ fallback
        var myLP = 0, rivalLP = 0;
        if (_pvpTurnMI && _pvpTurnMI.getLP) {
            try {
                myLP = callCardFn(_pvpTurnMI.getLP, [boxInt32(myself)]);
                rivalLP = callCardFn(_pvpTurnMI.getLP, [boxInt32(rival)]);
            } catch (e) {}
            if (myLP > 0 || rivalLP > 0) {
                online = true;  // confirmed PvP
                _isOnlineCache = true;
            }
        }
        if (myLP === 0 && rivalLP === 0) {
            // Try native XOR (solo mode)
            try {
                if (resolveNativeLP()) {
                    var xorKey = readXorKey();
                    var basePtr = readBasePtr();
                    myLP = xorKey ^ basePtr.add(myself * PLAYER_STRIDE).readS32();
                    rivalLP = xorKey ^ basePtr.add(rival * PLAYER_STRIDE).readS32();
                }
            } catch (e) {}
        }

        // Pick card method set based on detected mode
        var activeMI = online ? _pvpCardMI : _cardMI;
        if (!activeMI) activeMI = _pvpCardMI || _cardMI;
        if (!activeMI) return { error: "Could not resolve any card methods" };

        // Turn/Phase info — try PVP_ first, fall back to DLL_
        var turnPlayer = -1, phase = -1, turnNum = -1;
        if (_pvpTurnMI) {
            try {
                if (_pvpTurnMI.whichTurn) turnPlayer = callCardFn(_pvpTurnMI.whichTurn, []);
                if (_pvpTurnMI.getPhase) phase = callCardFn(_pvpTurnMI.getPhase, []);
                if (_pvpTurnMI.getTurnNum) turnNum = callCardFn(_pvpTurnMI.getTurnNum, []);
            } catch (e) {}
        }
        if (turnNum <= 0) {
            // Fallback to DLL_
            try {
                var whichTurn = findMethodByName(engineKlass, "DLL_DuelWhichTurnNow", -1);
                var getPhase = findMethodByName(engineKlass, "DLL_DuelGetCurrentPhase", -1);
                var getTurnNum = findMethodByName(engineKlass, "DLL_DuelGetTurnNum", -1);
                if (whichTurn) { var v = callCardFn(whichTurn, []); if (v >= 0) turnPlayer = v; }
                if (getPhase) { var v = callCardFn(getPhase, []); if (v >= 0) phase = v; }
                if (getTurnNum) { var v = callCardFn(getTurnNum, []); if (v > 0) turnNum = v; }
            } catch (e) {}
        }

        // Helper: collect cards in a zone range
        function zoneCards(player, zoneVal, label) {
            return getCardsInZone(player, zoneVal, label, activeMI);
        }

        // ── DEBUG: log card counts for field zones ──
        var _dbgCounts = [];
        for (var _dz = 1; _dz <= 12; _dz++) {
            var _cnt = callCardFn(activeMI.getCardNum, [boxInt32(myself), boxInt32(_dz)]);
            if (_cnt > 0) _dbgCounts.push("z" + _dz + "=" + _cnt);
        }
        var _handCnt = callCardFn(activeMI.getCardNum, [boxInt32(myself), boxInt32(13)]);
        _dbgCounts.push("hand=" + _handCnt);
        send("fieldDebug: player=" + myself + " online=" + online + " method=" + (activeMI === _pvpCardMI ? "PVP" : "DLL") + " counts=[" + _dbgCounts.join(",") + "]");
        // Also try with the OTHER method set for comparison
        var _altMI = (activeMI === _pvpCardMI) ? _cardMI : _pvpCardMI;
        if (_altMI) {
            var _altCounts = [];
            for (var _dz = 1; _dz <= 12; _dz++) {
                var _cnt2 = callCardFn(_altMI.getCardNum, [boxInt32(myself), boxInt32(_dz)]);
                if (_cnt2 > 0) _altCounts.push("z" + _dz + "=" + _cnt2);
            }
            var _altHand = callCardFn(_altMI.getCardNum, [boxInt32(myself), boxInt32(13)]);
            _altCounts.push("hand=" + _altHand);
            send("fieldDebug ALT: player=" + myself + " method=" + (_altMI === _pvpCardMI ? "PVP" : "DLL") + " counts=[" + _altCounts.join(",") + "]");
            // Also try player index 0 if we're using player 1
            if (myself === 1) {
                var _p0Counts = [];
                for (var _dz = 1; _dz <= 12; _dz++) {
                    var _cnt3 = callCardFn(activeMI.getCardNum, [boxInt32(0), boxInt32(_dz)]);
                    if (_cnt3 > 0) _p0Counts.push("z" + _dz + "=" + _cnt3);
                }
                send("fieldDebug p0: method=" + (activeMI === _pvpCardMI ? "PVP" : "DLL") + " counts=[" + _p0Counts.join(",") + "]");
            }
        }

        // ── MY side ──
        var myHand = zoneCards(myself, ZONE_HAND, "H");

        // Sanity check: if our hand has cards but ALL cardIds are 0,
        // we likely have the player index wrong (reading opponent's face-down hand).
        // Swap and retry.
        if (myHand.length > 0) {
            var allZero = true;
            for (var hi = 0; hi < myHand.length; hi++) {
                if (myHand[hi].cardId > 0) { allZero = false; break; }
            }
            if (allZero) {
                var swapped = myself === 0 ? 1 : 0;
                var testHand = zoneCards(swapped, ZONE_HAND, "H");
                var testHasIds = false;
                for (var hi = 0; hi < testHand.length; hi++) {
                    if (testHand[hi].cardId > 0) { testHasIds = true; break; }
                }
                if (testHasIds) {
                    send("gameState: player index was wrong (" + myself + "), swapping to " + swapped);
                    myself = swapped;
                    rival = swapped === 0 ? 1 : 0;
                    _pvpMyselfIndex = myself;
                    myHand = testHand;
                }
            }
        }

        var myMonsters = [];
        for (var z = ZONE_MONSTER_START; z <= ZONE_MONSTER_END; z++) {
            myMonsters = myMonsters.concat(zoneCards(myself, z, "M" + z));
        }
        var myExtraMonsters = [];
        for (var z = ZONE_EXTRA_MONSTER_1; z <= ZONE_EXTRA_MONSTER_2; z++) {
            myExtraMonsters = myExtraMonsters.concat(zoneCards(myself, z, "EM" + (z - ZONE_EXTRA_MONSTER_1 + 1)));
        }
        var mySpells = [];
        for (var z = ZONE_SPELL_START; z <= ZONE_SPELL_END; z++) {
            mySpells = mySpells.concat(zoneCards(myself, z, "S" + (z - ZONE_SPELL_START + 1)));
        }
        var myGY = zoneCards(myself, ZONE_GRAVE, "GY");
        var myDeckCount = 0;
        try { myDeckCount = callCardFn(activeMI.getCardNum, [boxInt32(myself), boxInt32(15)]); } catch (e) {}
        var myExtraDeckCount = 0;
        try { myExtraDeckCount = callCardFn(activeMI.getCardNum, [boxInt32(myself), boxInt32(14)]); } catch (e) {}

        // ── RIVAL side ──
        var rivalHand = zoneCards(rival, ZONE_HAND, "H");
        var rivalMonsters = [];
        for (var z = ZONE_MONSTER_START; z <= ZONE_MONSTER_END; z++) {
            rivalMonsters = rivalMonsters.concat(zoneCards(rival, z, "M" + z));
        }
        var rivalExtraMonsters = [];
        for (var z = ZONE_EXTRA_MONSTER_1; z <= ZONE_EXTRA_MONSTER_2; z++) {
            rivalExtraMonsters = rivalExtraMonsters.concat(zoneCards(rival, z, "EM" + (z - ZONE_EXTRA_MONSTER_1 + 1)));
        }
        var rivalSpells = [];
        for (var z = ZONE_SPELL_START; z <= ZONE_SPELL_END; z++) {
            rivalSpells = rivalSpells.concat(zoneCards(rival, z, "S" + (z - ZONE_SPELL_START + 1)));
        }
        var rivalGY = zoneCards(rival, ZONE_GRAVE, "GY");
        var rivalDeckCount = 0;
        try { rivalDeckCount = callCardFn(activeMI.getCardNum, [boxInt32(rival), boxInt32(15)]); } catch (e) {}

        // Banished zones (z17)
        var myBanished = zoneCards(myself, 17, "BN");
        var rivalBanished = zoneCards(rival, 17, "BN");

        return {
            myself: myself,
            rival: rival,
            myLP: myLP,
            rivalLP: rivalLP,
            turnPlayer: turnPlayer,
            phase: phase,
            turnNum: turnNum,
            online: online,
            myHand: myHand,
            rivalHand: rivalHand,
            myField: {
                monsters: myMonsters,
                spells: mySpells,
                extraMonsters: myExtraMonsters
            },
            rivalField: {
                monsters: rivalMonsters,
                spells: rivalSpells,
                extraMonsters: rivalExtraMonsters
            },
            myGY: myGY,
            rivalGY: rivalGY,
            myBanished: myBanished,
            rivalBanished: rivalBanished,
            myDeckCount: myDeckCount,
            myExtraDeckCount: myExtraDeckCount,
            rivalDeckCount: rivalDeckCount
        };
    },

    /**
     * Generic Engine method caller.
     * Calls any static DLL_Duel* method by name with int args.
     * Returns {result: int|null, error: string|null}.
     */
    callEngine: function (methodName, intArgs) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var paramCount = (intArgs && intArgs.length) || 0;
        var method = findMethodByName(engineKlass, methodName, paramCount);
        if (!method) {
            method = findMethodByName(engineKlass, methodName, -1);
            if (!method) return { error: "Method not found: " + methodName };
        }

        var args = [];
        if (intArgs) {
            for (var i = 0; i < intArgs.length; i++) {
                args.push(boxInt32(intArgs[i]));
            }
        }

        try {
            var result = invokeStatic(method, args);
            if (result && !result.isNull()) {
                try { return { result: result.add(0x10).readS32() }; }
                catch (e) { return { result: 0 }; }
            }
            return { result: null };
        } catch (e) {
            return { error: "invoke failed: " + e.message };
        }
    },

    /**
     * Scan all zones for command masks on each card.
     * Returns {commands: [{zone, index, mask, cardId, name, uid}],
     *          movablePhases, phase, turnPlayer, myself}.
     */
    getCommands: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };
        var inst = getStaticFieldPtr(engineKlass, "s_instance");
        if (!inst || inst.isNull()) return { error: "No duel active" };

        var activeMI = getActiveCardMI();
        if (!activeMI) return { error: "Card methods not resolved" };
        resolveNativeLP();

        var online = isOnlineMode();
        var pvpCmd = online ? resolvePvpCommandMethods() : null;

        // Resolve command methods — try PVP_ first when online
        var getCmdMask = (pvpCmd && pvpCmd["PVP_DuelComGetCommandMask"])
            ? pvpCmd["PVP_DuelComGetCommandMask"]
            : findMethodByName(engineKlass, "DLL_DuelComGetCommandMask", -1);
        var getMovable = (pvpCmd && pvpCmd["PVP_DuelComGetMovablePhase"])
            ? pvpCmd["PVP_DuelComGetMovablePhase"]
            : findMethodByName(engineKlass, "DLL_DuelComGetMovablePhase", -1);
        if (!getCmdMask) return { error: "ComGetCommandMask not found" };

        // ── Phase info FIRST — needed to determine correct player index ──
        var phase = -1, turnPlayer = -1, movablePhases = 0;
        try {
            var getPhase, whichTurn;
            if (online && _pvpTurnMI) {
                getPhase = _pvpTurnMI.getPhase;
                whichTurn = _pvpTurnMI.whichTurn;
            } else {
                getPhase = findMethodByName(engineKlass, "DLL_DuelGetCurrentPhase", -1);
                whichTurn = findMethodByName(engineKlass, "DLL_DuelWhichTurnNow", -1);
            }
            if (getPhase) phase = callCardFn(getPhase, []);
            if (whichTurn) turnPlayer = callCardFn(whichTurn, []);
            if (getMovable) movablePhases = callCardFn(getMovable, []);
        } catch (e) {}

        // ── Determine correct player index ──
        var myself = 0;
        try { if (_duelMyselfFn) myself = _duelMyselfFn(ptr(0)); } catch (e) {}

        // In PvP, DLL_DuelMyself() may return wrong value.
        // Use cached PvP index if available.
        if (online && _pvpMyselfIndex !== null) {
            myself = _pvpMyselfIndex;
        }
        // If movablePhases > 0, WE are the active player, so myself = turnPlayer.
        if (online && turnPlayer >= 0 && movablePhases > 0 && turnPlayer !== myself) {
            myself = turnPlayer;
            _pvpMyselfIndex = myself;  // Cache for gameState and future calls
        }

        var commands = [];

        // Scan: hand(13), monsters(1-5), spells(6-10), extra monsters(11-12)
        var scanZones = [13, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        for (var zi = 0; zi < scanZones.length; zi++) {
            var zv = scanZones[zi];
            var cardCount = callCardFn(activeMI.getCardNum, [boxInt32(myself), boxInt32(zv)]);
            for (var ci = 0; ci < cardCount && ci < 20; ci++) {
                try {
                    var mask = callCardFn(getCmdMask, [boxInt32(myself), boxInt32(zv), boxInt32(ci)]);
                    if (mask !== 0) {
                        var uid = callCardFn(activeMI.getCardUID, [boxInt32(myself), boxInt32(zv), boxInt32(ci)]);
                        var cardId = 0, name = null;
                        if (uid > 0) {
                            cardId = callCardFn(activeMI.getCardIDByUID, [boxInt32(uid)]);
                            if (cardId > 0) name = getCardName(cardId);
                        }
                        commands.push({
                            zone: zv, index: ci,
                            mask: mask, cardId: cardId,
                            name: name, uid: uid
                        });
                    }
                } catch (e) {}
            }
        }

        return {
            commands: commands,
            count: commands.length,
            movablePhases: movablePhases,
            phase: phase,
            turnPlayer: turnPlayer,
            myself: myself,
            online: online
        };
    },

    /**
     * Execute a command using managed ComDoCommand on the Unity main thread.
     * This is the correct way to submit player actions.
     * Params: player, zone, index, commandBit (int for CommandType enum)
     */
    doCommand: function (player, zone, index, commandBit) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        // Try PVP_ variant first when online
        var pvpCmd = isOnlineMode() ? resolvePvpCommandMethods() : null;
        if (pvpCmd && pvpCmd["PVP_ComDoCommand"]) {
            try {
                var result = runOnMainThread(function () {
                    invokeStatic(pvpCmd["PVP_ComDoCommand"], [
                        boxInt32(player), boxInt32(zone),
                        boxInt32(index), boxInt32(commandBit)
                    ]);
                    return "ok";
                });
                return { success: true, method: "PVP_ComDoCommand", result: result };
            } catch (e) {
                // Fall through to managed variants
            }
        }

        // Find the managed ComDoCommand (5 params: player, position, index, CommandType, bool)
        var comDoCmd = findMethodByName(engineKlass, "ComDoCommand", 5);
        if (!comDoCmd) {
            // Try THREAD_ variant as fallback
            comDoCmd = findMethodByName(engineKlass, "THREAD_ComDoCommand", 4);
            if (!comDoCmd) return { error: "ComDoCommand not found" };

            // THREAD_ variant: (player, position, index, commandId) — 4 int params
            try {
                var result = runOnMainThread(function () {
                    invokeStatic(comDoCmd, [
                        boxInt32(player), boxInt32(zone),
                        boxInt32(index), boxInt32(commandBit)
                    ]);
                    return "ok";
                });
                return { success: true, method: "THREAD_ComDoCommand", result: result };
            } catch (e) {
                return { error: "THREAD_ComDoCommand failed: " + e.message };
            }
        }

        // Managed ComDoCommand(player, position, index, CommandType commandId, bool checkCommand)
        try {
            var result = runOnMainThread(function () {
                invokeStatic(comDoCmd, [
                    boxInt32(player), boxInt32(zone),
                    boxInt32(index), boxInt32(commandBit),
                    boxBool(false)  // checkCommand = false (skip validation, just do it)
                ]);
                return "ok";
            });
            return { success: true, method: "ComDoCommand", result: result };
        } catch (e) {
            return { error: "ComDoCommand failed: " + e.message };
        }
    },

    /**
     * Move to a duel phase using managed ComMovePhase on main thread.
     */
    movePhase: function (phase) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var comMovePhase = findMethodByName(engineKlass, "ComMovePhase", 1);
        if (!comMovePhase) {
            comMovePhase = findMethodByName(engineKlass, "THREAD_ComMovePhase", 1);
            if (!comMovePhase) return { error: "ComMovePhase not found" };
        }

        try {
            var result = runOnMainThread(function () {
                invokeStatic(comMovePhase, [boxInt32(phase)]);
                return "ok";
            });
            return { success: true };
        } catch (e) {
            return { error: "ComMovePhase failed: " + e.message };
        }
    },

    /**
     * Cancel/pass current command using managed ComCancelCommand on main thread.
     */
    cancelCommand: function (decide) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var comCancel = findMethodByName(engineKlass, "ComCancelCommand", 1);
        if (!comCancel) {
            comCancel = findMethodByName(engineKlass, "THREAD_ComCancelCommand", 1);
            if (!comCancel) return { error: "ComCancelCommand not found" };
        }

        try {
            var result = runOnMainThread(function () {
                invokeStatic(comCancel, [boxBool(decide !== false)]);
                return "ok";
            });
            return { success: true };
        } catch (e) {
            return { error: "ComCancelCommand failed: " + e.message };
        }
    },

    /**
     * Submit a dialog result (yes/no, position select, etc.) on main thread.
     * result: uint32 value (e.g., 1=Yes, 0=No, or position mask)
     */
    dialogSetResult: function (result) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        // Try PVP_ variant first when online
        var pvpCmd = isOnlineMode() ? resolvePvpCommandMethods() : null;
        var dlgSetResult = (pvpCmd && pvpCmd["PVP_DuelDlgSetResult"])
            ? pvpCmd["PVP_DuelDlgSetResult"]
            : null;

        if (!dlgSetResult) {
            dlgSetResult = findMethodByName(engineKlass, "DialogSetResult", 1);
            if (!dlgSetResult) {
                dlgSetResult = findMethodByName(engineKlass, "THREAD_DuelDlgSetResult", 1);
                if (!dlgSetResult) return { error: "DialogSetResult not found" };
            }
        }

        try {
            runOnMainThread(function () {
                invokeStatic(dlgSetResult, [boxInt32(result)]);
                return "ok";
            });
            return { success: true };
        } catch (e) {
            return { error: "DialogSetResult failed: " + e.message };
        }
    },

    /**
     * Select an item from a list (target selection, materials, etc.) on main thread.
     */
    listSendIndex: function (index) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        // Try PVP_ variant first when online
        var pvpCmd = isOnlineMode() ? resolvePvpCommandMethods() : null;
        var listSend = (pvpCmd && pvpCmd["PVP_DuelListSendIndex"])
            ? pvpCmd["PVP_DuelListSendIndex"]
            : null;

        if (!listSend) {
            listSend = findMethodByName(engineKlass, "ListSendIndex", 1);
            if (!listSend) {
                listSend = findMethodByName(engineKlass, "THREAD_ListSendIndex", 1);
                if (!listSend) return { error: "ListSendIndex not found" };
            }
        }

        try {
            runOnMainThread(function () {
                invokeStatic(listSend, [boxInt32(index)]);
                return "ok";
            });
            return { success: true };
        } catch (e) {
            return { error: "ListSendIndex failed: " + e.message };
        }
    },

    /**
     * Get current input/dialog/list state for the autopilot to make decisions.
     * Returns what kind of input the engine is waiting for.
     */
    getInputState: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var online = isOnlineMode();
        var pvpCmd = online ? resolvePvpCommandMethods() : null;
        var state = {};

        // Helper: pick PVP_ method if available, else fall back to managed name
        function pickMethod(pvpName, managedName, paramCount) {
            if (pvpCmd && pvpCmd[pvpName]) return pvpCmd[pvpName];
            return findMethodByName(engineKlass, managedName, paramCount);
        }

        // Helper: read bool from invokeStatic result
        function readBool(method) {
            var r = invokeStatic(method, []);
            return (r && !r.isNull()) ? !!r.add(0x10).readU8() : false;
        }

        // Check if input is active
        try {
            var getInputNow = findMethodByName(engineKlass, "get_InputNow", 0);
            if (getInputNow) state.inputNow = readBool(getInputNow);
        } catch (e) { state.inputNow = null; }

        // Check SysAct loop status
        try {
            var isSysActLoop = pickMethod("PVP_IsSysActLoopExecute", "IsSysActLoopExecute", 0);
            if (isSysActLoop) state.sysActLoop = readBool(isSysActLoop);
        } catch (e) { state.sysActLoop = null; }

        // Dialog state
        try {
            var dlgSelectNum = pickMethod("PVP_DuelDlgGetSelectItemNum", "DialogGetSelectItemNum", 0);
            if (dlgSelectNum) state.dialogSelectNum = callCardFn(dlgSelectNum, []);
        } catch (e) { state.dialogSelectNum = 0; }

        try {
            var dlgCanSkip = pickMethod("PVP_DuelDlgCanYesNoSkip", "DialogCanYesNoSkip", 0);
            if (dlgCanSkip) state.dialogCanSkip = readBool(dlgCanSkip);
        } catch (e) { state.dialogCanSkip = null; }

        try {
            var dlgPosMask = pickMethod("PVP_DuelDlgGetPosMaskOfThisSummon", "DialogGetPosMaskOfThisSummon", 0);
            if (dlgPosMask) state.dialogPosMask = callCardFn(dlgPosMask, []);
        } catch (e) { state.dialogPosMask = 0; }

        // List state
        try {
            var listMax = pickMethod("PVP_DuelListGetItemMax", "ListGetItemMax", 0);
            if (listMax) state.listItemMax = callCardFn(listMax, []);
        } catch (e) { state.listItemMax = 0; }

        try {
            var listMulti = pickMethod("PVP_DuelListIsMultiMode", "ListIsMultiMode", 0);
            if (listMulti) state.listMultiMode = readBool(listMulti);
        } catch (e) { state.listMultiMode = false; }

        try {
            var listSelMax = pickMethod("PVP_DuelListGetSelectMax", "ListGetSelectMax", 0);
            var listSelMin = pickMethod("PVP_DuelListGetSelectMin", "ListGetSelectMin", 0);
            if (listSelMax) state.listSelectMax = callCardFn(listSelMax, []);
            if (listSelMin) state.listSelectMin = callCardFn(listSelMin, []);
        } catch (e) {}

        // Get list item details if list is active
        if (state.listItemMax > 0) {
            state.listItems = [];
            var listGetItemID = pickMethod("PVP_DuelListGetItemID", "ListGetItemID", 1);
            var listGetItemUID = pickMethod("PVP_DuelListGetItemUniqueID", "ListGetItemUniqueID", 1);
            var listGetItemFrom = pickMethod("PVP_DuelListGetItemFrom", "ListGetItemFrom", 1);
            for (var i = 0; i < state.listItemMax && i < 30; i++) {
                var item = { index: i };
                try {
                    if (listGetItemID) item.cardId = callCardFn(listGetItemID, [boxInt32(i)]);
                    if (listGetItemUID) item.uid = callCardFn(listGetItemUID, [boxInt32(i)]);
                    if (listGetItemFrom) item.from = callCardFn(listGetItemFrom, [boxInt32(i)]);
                    if (item.cardId > 0) item.name = getCardName(item.cardId);
                } catch (e) {}
                state.listItems.push(item);
            }
        }

        // Get dialog mix data if present
        try {
            var dlgMixNum = pickMethod("PVP_DuelDlgGetMixNum", "DialogGetMixNum", 0);
            if (dlgMixNum) state.dialogMixNum = callCardFn(dlgMixNum, []);
        } catch (e) { state.dialogMixNum = 0; }

        return state;
    },

    /**
     * Auto-select default location on main thread.
     */
    defaultLocation: function () {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var defLoc = findMethodByName(engineKlass, "DLL_DuelComDefaultLocation", 0);
        if (!defLoc) return { error: "DLL_DuelComDefaultLocation not found" };

        try {
            runOnMainThread(function () {
                invokeStatic(defLoc, []);
                return "ok";
            });
            return { success: true };
        } catch (e) {
            return { error: "DefaultLocation failed: " + e.message };
        }
    },

    /**
     * Enable/disable AI auto-play by hooking DLL_DuelSetPlayerType in duel.dll.
     * Uses the same approach as the CE "AI vs AI" script:
     * Intercepts calls to SetPlayerType and forces the type to 1 (CPU).
     * This is safe because it hooks at the native level and only modifies
     * the argument when the game naturally calls the function.
     *
     * enable=true:  force all SetPlayerType calls to write 1 (CPU)
     * enable=false: remove the hook, restore original behavior
     */
    hookAutoplay: function (enable) {
        return _hookAutoplay(enable);
    },

    /**
     * Check if a player is Human by reading native duel engine memory directly.
     * DLL_DuelIsHuman reads: base_ptr[player*4+8] == 0 ? true : false
     * Player type 0 = Human, type != 0 = CPU
     */
    isPlayerHuman: function (player) {
        return _readPlayerType(player);
    },

    /**
     * Call ComMovePhase via direct native function call (like CE script does).
     * Gets the compiled native address of the method and calls it directly
     * instead of going through il2cpp_runtime_invoke.
     */
    nativeMovePhase: function (phase) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var methodInfo = findMethodByName(engineKlass, "ComMovePhase", 1);
        if (!methodInfo) return { error: "ComMovePhase not found" };

        try {
            // Read the native function pointer from MethodInfo
            // In IL2CPP, MethodInfo->methodPointer is at offset 0
            var nativeAddr = methodInfo.readPointer();
            if (nativeAddr.isNull()) return { error: "Native addr is null" };

            // IL2CPP static method signature: void ComMovePhase(int phase, MethodInfo* method)
            var nativeFn = new NativeFunction(nativeAddr, "void", ["int32", "pointer"]);
            nativeFn(phase, methodInfo);
            return { success: true, addr: nativeAddr.toString() };
        } catch (e) {
            return { error: "nativeMovePhase failed: " + e.message };
        }
    },

    /**
     * Call ComDoCommand via direct native function call.
     */
    nativeDoCommand: function (player, zone, index, commandBit, checkCommand) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var methodInfo = findMethodByName(engineKlass, "ComDoCommand", 5);
        if (!methodInfo) return { error: "ComDoCommand not found" };

        try {
            var nativeAddr = methodInfo.readPointer();
            if (nativeAddr.isNull()) return { error: "Native addr is null" };

            // void ComDoCommand(int player, int position, int index, int commandId, bool checkCommand, MethodInfo* method)
            var nativeFn = new NativeFunction(nativeAddr, "void", ["int32", "int32", "int32", "int32", "uint8", "pointer"]);
            nativeFn(player, zone, index, commandBit, checkCommand ? 1 : 0, methodInfo);
            return { success: true, addr: nativeAddr.toString() };
        } catch (e) {
            return { error: "nativeDoCommand failed: " + e.message };
        }
    },

    /**
     * Call ComCancelCommand via direct native function call.
     */
    nativeCancelCommand: function (decide) {
        var domain = il2cpp_domain_get();
        il2cpp_thread_attach(domain);

        var engineKlass = findEngineClass();
        if (!engineKlass) return { error: "Engine class not found" };

        var methodInfo = findMethodByName(engineKlass, "ComCancelCommand", 1);
        if (!methodInfo) return { error: "ComCancelCommand not found" };

        try {
            var nativeAddr = methodInfo.readPointer();
            if (nativeAddr.isNull()) return { error: "Native addr is null" };

            // void ComCancelCommand(bool decide, MethodInfo* method)
            var nativeFn = new NativeFunction(nativeAddr, "void", ["uint8", "pointer"]);
            nativeFn(decide ? 1 : 0, methodInfo);
            return { success: true };
        } catch (e) {
            return { error: "nativeCancelCommand failed: " + e.message };
        }
    }
};

// ── AI vs AI: Hook DLL_DuelSetPlayerType in duel.dll ──
// Same approach as CE "AI vs AI" script: intercept SetPlayerType and force type=1 (CPU)
var _autoplayHooked = false;
var _autoplayEnabled = false;
var _autoplayInterceptor = null;

function _hookAutoplay(enable) {
    if (enable && !_autoplayHooked) {
        // Find DLL_DuelSetPlayerType in duel.dll
        try {
            var duelDll = Process.getModuleByName("duel.dll");
            var setPlayerTypeAddr = duelDll.findExportByName("DLL_DuelSetPlayerType");
            if (!setPlayerTypeAddr) {
                return { error: "DLL_DuelSetPlayerType not found in duel.dll" };
            }

            // Hook the function — when autopilot is on, force args[1] (playerType) to 1 (CPU)
            _autoplayInterceptor = Interceptor.attach(setPlayerTypeAddr, {
                onEnter: function (args) {
                    if (_autoplayEnabled) {
                        args[1] = ptr(1); // Force type=1 (CPU) for ALL players
                    }
                }
            });
            _autoplayHooked = true;
            send("autoplay: hook installed on DLL_DuelSetPlayerType");
        } catch (e) {
            return { error: "Hook failed: " + e.message };
        }
    }

    _autoplayEnabled = enable;

    if (enable) {
        // The hook will automatically force CPU type on the NEXT SetPlayerType call.
        // If a duel is already active, try to set type directly via native call.
        // If no duel active (global ptr is null), skip the direct call — the hook
        // will catch it when the duel starts.
        try {
            var duelDll = Process.getModuleByName("duel.dll");
            var isHumanAddr = duelDll.findExportByName("DLL_DuelIsHuman");
            if (isHumanAddr) {
                var isHumanFn = new NativeFunction(isHumanAddr, "int32", ["int32"]);
                // Test if duel is active by reading player type (will AV if no duel)
                isHumanFn(0);
                // If we get here, duel is active — set both players to CPU
                var setTypeAddr = duelDll.findExportByName("DLL_DuelSetPlayerType");
                if (setTypeAddr) {
                    var setTypeFn = new NativeFunction(setTypeAddr, "void", ["int32", "int32"]);
                    setTypeFn(0, 1); // player 0 -> CPU
                    setTypeFn(1, 1); // player 1 -> CPU
                    send("autoplay: both players set to CPU");
                }
            }
        } catch (e) {
            // No duel active — hook will catch it when duel starts
            send("autoplay: hook ready, will activate on next duel start");
        }
        return { success: true, enabled: true };
    } else {
        // Disable: try to restore player 0 to Human
        try {
            var duelDll = Process.getModuleByName("duel.dll");
            var setTypeAddr = duelDll.findExportByName("DLL_DuelSetPlayerType");
            if (setTypeAddr) {
                var setTypeFn = new NativeFunction(setTypeAddr, "void", ["int32", "int32"]);
                setTypeFn(0, 0); // player 0 -> Human
            }
        } catch (e) {
            // No duel active — nothing to restore
        }
        return { success: true, enabled: false };
    }
}

function _readPlayerType(player) {
    try {
        var duelDll = Process.getModuleByName("duel.dll");
        var isHumanAddr = duelDll.findExportByName("DLL_DuelIsHuman");
        if (!isHumanAddr) return { error: "DLL_DuelIsHuman not found" };

        var isHumanFn = new NativeFunction(isHumanAddr, "int32", ["int32"]);
        var result = isHumanFn(player);
        return { isHuman: result !== 0, player: player };
    } catch (e) {
        return { error: "DLL_DuelIsHuman failed: " + e.message };
    }
}

// ── Helper: poll Handle for completion ──

function _pollHandle(handleObj) {
    var handleClass = findClassByName("YgomSystem.Network", "Handle");
    if (!handleClass) return { success: false, code: -1, error: "Handle class not found" };

    var isCompletedMethod = findMethodByName(handleClass, "IsCompleted", 0);
    var isErrorMethod = findMethodByName(handleClass, "IsError", 0);
    var getCodeMethod = findMethodByName(handleClass, "GetCode", 0);

    if (!isCompletedMethod) return { success: false, code: -1, error: "Handle.IsCompleted not found" };

    // Poll for up to 15 seconds (150 * 100ms)
    for (var i = 0; i < 150; i++) {
        try {
            var completedResult = invokeInstance(isCompletedMethod, handleObj, []);
            if (completedResult && !completedResult.isNull()) {
                var completed = completedResult.add(0x10).readU8();
                if (completed) {
                    var isError = false;
                    if (isErrorMethod) {
                        var errResult = invokeInstance(isErrorMethod, handleObj, []);
                        if (errResult && !errResult.isNull()) {
                            isError = !!errResult.add(0x10).readU8();
                        }
                    }

                    var code = 0;
                    if (getCodeMethod) {
                        var codeResult = invokeInstance(getCodeMethod, handleObj, []);
                        if (codeResult && !codeResult.isNull()) {
                            code = codeResult.add(0x10).readS32();
                        }
                    }

                    return { success: !isError, code: code, error: isError ? "API error code " + code : null };
                }
            }
        } catch (e) {
            // Method call failed, retry
        }

        Thread.sleep(0.1);
    }

    return { success: false, code: -1, error: "Handle poll timeout (15s)" };
}

/**
 * Poll Handle for completion and also read GetParam() result.
 * Returns {success, code, data, error}.
 */
function _pollHandleWithParam(handleObj) {
    var handleClass = findClassByName("YgomSystem.Network", "Handle");
    if (!handleClass) return { success: false, error: "Handle class not found" };

    var isCompletedMethod = findMethodByName(handleClass, "IsCompleted", 0);
    var isErrorMethod = findMethodByName(handleClass, "IsError", 0);
    var getCodeMethod = findMethodByName(handleClass, "GetCode", 0);
    var getParamMethod = findMethodByName(handleClass, "GetParam", 0);

    if (!isCompletedMethod) return { success: false, error: "IsCompleted not found" };

    for (var i = 0; i < 150; i++) {
        try {
            var completedResult = invokeInstance(isCompletedMethod, handleObj, []);
            if (completedResult && !completedResult.isNull() && completedResult.add(0x10).readU8()) {
                var isError = false;
                if (isErrorMethod) {
                    var errResult = invokeInstance(isErrorMethod, handleObj, []);
                    if (errResult && !errResult.isNull()) isError = !!errResult.add(0x10).readU8();
                }

                var code = 0;
                if (getCodeMethod) {
                    var codeResult = invokeInstance(getCodeMethod, handleObj, []);
                    if (codeResult && !codeResult.isNull()) code = codeResult.add(0x10).readS32();
                }

                var data = null;
                if (getParamMethod && !isError) {
                    try {
                        var paramResult = invokeInstance(getParamMethod, handleObj, []);
                        if (paramResult && !paramResult.isNull()) {
                            data = readObjectValue(paramResult, 0);
                        }
                    } catch (e) {
                        data = { _error: "GetParam failed: " + e.message };
                    }
                }

                return {
                    success: !isError,
                    code: code,
                    data: data,
                    error: isError ? "API error code " + code : null
                };
            }
        } catch (e) {}

        Thread.sleep(0.1);
    }

    return { success: false, error: "Handle poll timeout (15s)" };
}
