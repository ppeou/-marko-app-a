/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("undefined$0", "marko", "4.18.39");
$_mod.main("/marko$4.18.39/src/runtime/vdom", "");
$_mod.main("/marko$4.18.39/src", "");
$_mod.remap("/marko$4.18.39/src/index", "/marko$4.18.39/src/index-browser");
$_mod.def("/marko$4.18.39/src/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
    actualCreateOut = createOutFunc;
}

function createOut(globalData) {
    return actualCreateOut(globalData);
}

createOut.___setCreateOut = setCreateOut;

module.exports = createOut;

});
$_mod.main("/marko$4.18.39/src/loader", "");
$_mod.remap("/marko$4.18.39/src/loader/index", "/marko$4.18.39/src/loader/index-browser");
$_mod.def("/marko$4.18.39/src/loader/index-browser", function(require, exports, module, __filename, __dirname) { "use strict";
module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    // eslint-disable-next-line no-undef
    if (typeof __webpack_require__ !== "undefined") {
        // In webpack we can accept paths from `require.resolve`.
        // eslint-disable-next-line no-undef
        return __webpack_require__(templatePath);
    } else {
        return require(templatePath);
    }
};

});
$_mod.def("/marko$4.18.39/src/index-browser", function(require, exports, module, __filename, __dirname) { "use strict";
exports.createOut = require('/marko$4.18.39/src/runtime/createOut'/*"./runtime/createOut"*/);
exports.load = require('/marko$4.18.39/src/loader/index-browser'/*"./loader"*/);

});
$_mod.installed("marko$4.18.39", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src\\index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
function VNode() {}

VNode.prototype = {
    ___VNode: function(finalChildCount) {
        this.___finalChildCount = finalChildCount;
        this.___childCount = 0;
        this.___firstChildInternal = null;
        this.___lastChild = null;
        this.___parentNode = null;
        this.___nextSiblingInternal = null;
    },

    ___ownerComponent: null,

    get ___firstChild() {
        var firstChild = this.___firstChildInternal;

        if (firstChild && firstChild.___DocumentFragment) {
            var nestedFirstChild = firstChild.___firstChild;
            // The first child is a DocumentFragment node.
            // If the DocumentFragment node has a first child then we will return that.
            // Otherwise, the DocumentFragment node is not *really* the first child and
            // we need to skip to its next sibling
            return nestedFirstChild || firstChild.___nextSibling;
        }

        return firstChild;
    },

    get ___nextSibling() {
        var nextSibling = this.___nextSiblingInternal;

        if (nextSibling) {
            if (nextSibling.___DocumentFragment) {
                var firstChild = nextSibling.___firstChild;
                return firstChild || nextSibling.___nextSibling;
            }
        } else {
            var parentNode = this.___parentNode;
            if (parentNode && parentNode.___DocumentFragment) {
                return parentNode.___nextSibling;
            }
        }

        return nextSibling;
    },

    ___appendChild: function(child) {
        this.___childCount++;

        if (this.___nodeName === "textarea") {
            if (child.___Text) {
                var childValue = child.___nodeValue;
                this.___valueInternal =
                    (this.___valueInternal || "") + childValue;
            } else if (child.___preserve) {
                this.___preserveTextAreaValue = true;
            } else {
                throw TypeError();
            }
        } else {
            var lastChild = this.___lastChild;

            child.___parentNode = this;

            if (lastChild) {
                lastChild.___nextSiblingInternal = child;
            } else {
                this.___firstChildInternal = child;
            }

            this.___lastChild = child;
        }

        return child;
    },

    ___finishChild: function finishChild() {
        if (
            this.___childCount === this.___finalChildCount &&
            this.___parentNode
        ) {
            return this.___parentNode.___finishChild();
        } else {
            return this;
        }
    }

    // ,toJSON: function() {
    //     var clone = Object.assign({
    //         nodeType: this.nodeType
    //     }, this);
    //
    //     for (var k in clone) {
    //         if (k.startsWith('_')) {
    //             delete clone[k];
    //         }
    //     }
    //     delete clone._nextSibling;
    //     delete clone._lastChild;
    //     delete clone.parentNode;
    //     return clone;
    // }
};

module.exports = VNode;

});
$_mod.installed("marko$4.18.39", "raptor-util", "3.2.0");
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComment(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VComment.prototype = {
    ___nodeType: 8,

    ___actualize: function(doc) {
        var nodeValue = this.___nodeValue;
        return doc.createComment(nodeValue);
    },

    ___cloneNode: function() {
        return new VComment(this.___nodeValue);
    }
};

inherit(VComment, VNode);

module.exports = VComment;

});
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function VDocumentFragmentClone(other) {
    extend(this, other);
    this.___parentNode = null;
    this.___nextSiblingInternal = null;
}

function VDocumentFragment(out) {
    this.___VNode(null /* childCount */);
    this.___out = out;
}

VDocumentFragment.prototype = {
    ___nodeType: 11,

    ___DocumentFragment: true,

    ___cloneNode: function() {
        return new VDocumentFragmentClone(this);
    },

    ___actualize: function(doc) {
        return doc.createDocumentFragment();
    }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;

});
$_mod.def("/marko$4.18.39/src/runtime/components/dom-data", function(require, exports, module, __filename, __dirname) { var counter = 0;
var seed = "M" + Math.random().toFixed(5);
var WeakMap =
    global.WeakMap ||
    function WeakMap() {
        var id = seed + counter++;
        return {
            get: function(ref) {
                return ref[id];
            },
            set: function(ref, value) {
                ref[id] = value;
            }
        };
    };

module.exports = {
    ___vPropsByDOMNode: new WeakMap(),
    ___vElementByDOMNode: new WeakMap(),
    ___componentByDOMNode: new WeakMap(),
    ___detachedByDOMNode: new WeakMap(),
    ___keyByDOMNode: new WeakMap()
};

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"../components/dom-data"*/);
var vElementByDOMNode = domData.___vElementByDOMNode;
var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var ATTR_XLINK_HREF = "xlink:href";
var xmlnsRegExp = /^xmlns(:|$)/;
var NS_XLINK = "http://www.w3.org/1999/xlink";
var NS_HTML = "http://www.w3.org/1999/xhtml";
var NS_MATH = "http://www.w3.org/1998/Math/MathML";
var NS_SVG = "http://www.w3.org/2000/svg";
var DEFAULT_NS = {
    svg: NS_SVG,
    math: NS_MATH
};

var toString = String;

var FLAG_SIMPLE_ATTRS = 1;
var FLAG_CUSTOM_ELEMENT = 2;

var defineProperty = Object.defineProperty;

var ATTR_HREF = "href";
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
    if (value === true) {
        return "";
    } else if (type == "object") {
        return value instanceof RegExp ? value.source : JSON.stringify(value);
    } else {
        return toString(value);
    }
}

function assign(a, b) {
    for (var key in b) {
        if (b.hasOwnProperty(key)) {
            a[key] = b[key];
        }
    }
}

function setAttribute(el, namespaceURI, name, value) {
    if (namespaceURI === null) {
        el.setAttribute(name, value);
    } else {
        el.setAttributeNS(namespaceURI, name, value);
    }
}

function removeAttribute(el, namespaceURI, name) {
    if (namespaceURI === null) {
        el.removeAttribute(name);
    } else {
        el.removeAttributeNS(namespaceURI, name);
    }
}

function VElementClone(other) {
    this.___firstChildInternal = other.___firstChildInternal;
    this.___parentNode = null;
    this.___nextSiblingInternal = null;

    this.___key = other.___key;
    this.___attributes = other.___attributes;
    this.___properties = other.___properties;
    this.___nodeName = other.___nodeName;
    this.___flags = other.___flags;
    this.___valueInternal = other.___valueInternal;
    this.___constId = other.___constId;
}

function VElement(
    tagName,
    attrs,
    key,
    ownerComponent,
    childCount,
    flags,
    props
) {
    this.___VNode(childCount);

    var constId;

    if (props) {
        constId = props.i;
    }

    this.___key = key;
    this.___flags = flags || 0;
    this.___ownerComponent = ownerComponent;
    this.___attributes = attrs || EMPTY_OBJECT;
    this.___properties = props || EMPTY_OBJECT;
    this.___nodeName = tagName;
    this.___valueInternal = null;
    this.___constId = constId;
}

VElement.prototype = {
    ___nodeType: 1,

    ___cloneNode: function() {
        return new VElementClone(this);
    },

    /**
     * Shorthand method for creating and appending an HTML element
     *
     * @param  {String} tagName    The tag name (e.g. "div")
     * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
     * @param  {int|null} childCount The number of child nodes (or `null` if not known)
     */
    e: function(tagName, attrs, key, ownerComponent, childCount, flags, props) {
        var child = this.___appendChild(
            new VElement(
                tagName,
                attrs,
                key,
                ownerComponent,
                childCount,
                flags,
                props
            )
        );

        if (childCount === 0) {
            return this.___finishChild();
        } else {
            return child;
        }
    },

    /**
     * Shorthand method for creating and appending a static node. The provided node is automatically cloned
     * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
     *
     * @param  {String} value The value for the new Comment node
     */
    n: function(node, ownerComponent) {
        node = node.___cloneNode();
        node.___ownerComponent = ownerComponent;
        this.___appendChild(node);
        return this.___finishChild();
    },

    ___actualize: function(doc, parentNamespaceURI) {
        var tagName = this.___nodeName;
        var attributes = this.___attributes;
        var namespaceURI = DEFAULT_NS[tagName] || parentNamespaceURI || NS_HTML;

        var flags = this.___flags;
        var el = doc.createElementNS(namespaceURI, tagName);

        if (flags & FLAG_CUSTOM_ELEMENT) {
            assign(el, attributes);
        } else {
            for (var attrName in attributes) {
                var attrValue = attributes[attrName];

                if (attrValue !== false && attrValue != null) {
                    var type = typeof attrValue;

                    if (type !== "string") {
                        // Special attributes aren't copied to the real DOM. They are only
                        // kept in the virtual attributes map
                        attrValue = convertAttrValue(type, attrValue);
                    }

                    if (attrName == ATTR_XLINK_HREF) {
                        setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
                    } else {
                        el.setAttribute(attrName, attrValue);
                    }
                }
            }

            if (tagName === "textarea") {
                el.value = this.___value;
            }
        }

        vElementByDOMNode.set(el, this);

        return el;
    },

    ___hasAttribute: function(name) {
        // We don't care about the namespaces since the there
        // is no chance that attributes with the same name will have
        // different namespaces
        var value = this.___attributes[name];
        return value != null && value !== false;
    }
};

inherit(VElement, VNode);

var proto = (VElementClone.prototype = VElement.prototype);

["checked", "selected", "disabled"].forEach(function(name) {
    defineProperty(proto, name, {
        get: function() {
            var value = this.___attributes[name];
            return value !== false && value != null;
        }
    });
});

defineProperty(proto, "___value", {
    get: function() {
        var value = this.___valueInternal;
        if (value == null) {
            value = this.___attributes.value;
        }
        return value != null && value !== false
            ? toString(value)
            : this.___attributes.type === "checkbox" ||
              this.___attributes.type === "radio"
            ? "on"
            : "";
    }
});

VElement.___removePreservedAttributes = function(attrs) {
    // By default this static method is a no-op, but if there are any
    // compiled components that have "no-update" attributes then
    // `preserve-attrs.js` will be imported and this method will be replaced
    // with a method that actually does something
    return attrs;
};

function virtualizeElement(node, virtualizeChildNodes) {
    var attributes = node.attributes;
    var attrCount = attributes.length;

    var attrs;

    if (attrCount) {
        attrs = {};
        for (var i = 0; i < attrCount; i++) {
            var attr = attributes[i];
            var attrName = attr.name;
            if (!xmlnsRegExp.test(attrName) && attrName !== "data-marko") {
                var attrNamespaceURI = attr.namespaceURI;
                if (attrNamespaceURI === NS_XLINK) {
                    attrs[ATTR_XLINK_HREF] = attr.value;
                } else {
                    attrs[attrName] = attr.value;
                }
            }
        }
    }

    var tagName = node.nodeName;

    if (node.namespaceURI === NS_HTML) {
        tagName = tagName.toLowerCase();
    }

    var vdomEl = new VElement(
        tagName,
        attrs,
        null /*key*/,
        null /*ownerComponent*/,
        0 /*child count*/,
        0 /*flags*/,
        null /*props*/
    );

    if (vdomEl.___nodeName === "textarea") {
        vdomEl.___valueInternal = node.value;
    } else if (virtualizeChildNodes) {
        virtualizeChildNodes(node, vdomEl);
    }

    return vdomEl;
}

VElement.___virtualize = virtualizeElement;

VElement.___morphAttrs = function(fromEl, vFromEl, toEl) {
    var removePreservedAttributes = VElement.___removePreservedAttributes;

    var fromFlags = vFromEl.___flags;
    var toFlags = toEl.___flags;

    vElementByDOMNode.set(fromEl, toEl);

    var attrs = toEl.___attributes;
    var props = toEl.___properties;

    if (toFlags & FLAG_CUSTOM_ELEMENT) {
        return assign(fromEl, attrs);
    }

    var attrName;

    // We use expando properties to associate the previous HTML
    // attributes provided as part of the VDOM node with the
    // real VElement DOM node. When diffing attributes,
    // we only use our internal representation of the attributes.
    // When diffing for the first time it's possible that the
    // real VElement node will not have the expando property
    // so we build the attribute map from the expando property

    var oldAttrs = vFromEl.___attributes;

    if (oldAttrs) {
        if (oldAttrs === attrs) {
            // For constant attributes the same object will be provided
            // every render and we can use that to our advantage to
            // not waste time diffing a constant, immutable attribute
            // map.
            return;
        } else {
            oldAttrs = removePreservedAttributes(oldAttrs, props);
        }
    }

    var attrValue;

    if (toFlags & FLAG_SIMPLE_ATTRS && fromFlags & FLAG_SIMPLE_ATTRS) {
        if (oldAttrs["class"] !== (attrValue = attrs["class"])) {
            fromEl.className = attrValue;
        }
        if (oldAttrs.id !== (attrValue = attrs.id)) {
            fromEl.id = attrValue;
        }
        if (oldAttrs.style !== (attrValue = attrs.style)) {
            fromEl.style.cssText = attrValue;
        }
        return;
    }

    // In some cases we only want to set an attribute value for the first
    // render or we don't want certain attributes to be touched. To support
    // that use case we delete out all of the preserved attributes
    // so it's as if they never existed.
    attrs = removePreservedAttributes(attrs, props, true);

    var namespaceURI;

    // Loop over all of the attributes in the attribute map and compare
    // them to the value in the old map. However, if the value is
    // null/undefined/false then we want to remove the attribute
    for (attrName in attrs) {
        attrValue = attrs[attrName];
        namespaceURI = null;

        if (attrName === ATTR_XLINK_HREF) {
            namespaceURI = NS_XLINK;
            attrName = ATTR_HREF;
        }

        if (attrValue == null || attrValue === false) {
            removeAttribute(fromEl, namespaceURI, attrName);
        } else if (oldAttrs[attrName] !== attrValue) {
            var type = typeof attrValue;

            if (type !== "string") {
                attrValue = convertAttrValue(type, attrValue);
            }

            setAttribute(fromEl, namespaceURI, attrName, attrValue);
        }
    }

    // If there are any old attributes that are not in the new set of attributes
    // then we need to remove those attributes from the target node
    //
    // NOTE: We can skip this if the the element is keyed because if the element
    //       is keyed then we know we already processed all of the attributes for
    //       both the target and original element since target VElement nodes will
    //       have all attributes declared. However, we can only skip if the node
    //       was not a virtualized node (i.e., a node that was not rendered by a
    //       Marko template, but rather a node that was created from an HTML
    //       string or a real DOM node).
    if (toEl.___key === null) {
        for (attrName in oldAttrs) {
            if (!(attrName in attrs)) {
                if (attrName === ATTR_XLINK_HREF) {
                    fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
                } else {
                    fromEl.removeAttribute(attrName);
                }
            }
        }
    }
};

module.exports = VElement;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VText(value) {
    this.___VNode(-1 /* no children */);
    this.___nodeValue = value;
}

VText.prototype = {
    ___Text: true,

    ___nodeType: 3,

    ___actualize: function(doc) {
        return doc.createTextNode(this.___nodeValue);
    },

    ___cloneNode: function() {
        return new VText(this.___nodeValue);
    }
};

inherit(VText, VNode);

module.exports = VText;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VComponent", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComponent(component, key, ownerComponent, preserve) {
    this.___VNode(null /* childCount */);
    this.___key = key;
    this.___component = component;
    this.___ownerComponent = ownerComponent;
    this.___preserve = preserve;
}

VComponent.prototype = {
    ___nodeType: 2
};

inherit(VComponent, VNode);

module.exports = VComponent;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/morphdom/helpers", function(require, exports, module, __filename, __dirname) { function insertBefore(node, referenceNode, parentNode) {
    if (node.insertInto) {
        return node.insertInto(parentNode, referenceNode);
    }
    return parentNode.insertBefore(
        node,
        (referenceNode && referenceNode.startNode) || referenceNode
    );
}

function insertAfter(node, referenceNode, parentNode) {
    return insertBefore(
        node,
        referenceNode && referenceNode.nextSibling,
        parentNode
    );
}

function nextSibling(node) {
    var next = node.nextSibling;
    var fragment = next && next.fragment;
    if (fragment) {
        return next === fragment.startNode ? fragment : null;
    }
    return next;
}

function firstChild(node) {
    var next = node.firstChild;
    return (next && next.fragment) || next;
}

function removeChild(node) {
    if (node.remove) node.remove();
    else node.parentNode.removeChild(node);
}

exports.___insertBefore = insertBefore;
exports.___insertAfter = insertAfter;
exports.___nextSibling = nextSibling;
exports.___firstChild = firstChild;
exports.___removeChild = removeChild;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/morphdom/fragment", function(require, exports, module, __filename, __dirname) { var helpers = require('/marko$4.18.39/src/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var insertBefore = helpers.___insertBefore;

var fragmentPrototype = {
    nodeType: 12,
    get firstChild() {
        var firstChild = this.startNode.nextSibling;
        return firstChild === this.endNode ? undefined : firstChild;
    },
    get lastChild() {
        var lastChild = this.endNode.previousSibling;
        return lastChild === this.startNode ? undefined : lastChild;
    },
    get parentNode() {
        var parentNode = this.startNode.parentNode;
        return parentNode === this.detachedContainer ? undefined : parentNode;
    },
    get namespaceURI() {
        return this.startNode.parentNode.namespaceURI;
    },
    get nextSibling() {
        return this.endNode.nextSibling;
    },
    get nodes() {
        var nodes = [];
        var current = this.startNode;
        while (current !== this.endNode) {
            nodes.push(current);
            current = current.nextSibling;
        }
        nodes.push(current);
        return nodes;
    },
    insertBefore: function(newChildNode, referenceNode) {
        var actualReference =
            referenceNode == null ? this.endNode : referenceNode;
        return insertBefore(
            newChildNode,
            actualReference,
            this.startNode.parentNode
        );
    },
    insertInto: function(newParentNode, referenceNode) {
        this.nodes.forEach(function(node) {
            insertBefore(node, referenceNode, newParentNode);
        }, this);
        return this;
    },
    remove: function() {
        this.nodes.forEach(function(node) {
            this.detachedContainer.appendChild(node);
        }, this);
    }
};

function createFragmentNode(startNode, nextNode, parentNode) {
    var fragment = Object.create(fragmentPrototype);
    var isRoot = startNode && startNode.ownerDocument === startNode.parentNode;
    fragment.startNode = isRoot
        ? document.createComment("")
        : document.createTextNode("");
    fragment.endNode = isRoot
        ? document.createComment("")
        : document.createTextNode("");
    fragment.startNode.fragment = fragment;
    fragment.endNode.fragment = fragment;
    var detachedContainer = (fragment.detachedContainer = document.createDocumentFragment());
    parentNode =
        parentNode || (startNode && startNode.parentNode) || detachedContainer;
    insertBefore(fragment.startNode, startNode, parentNode);
    insertBefore(fragment.endNode, nextNode, parentNode);
    return fragment;
}

function beginFragmentNode(startNode, parentNode) {
    var fragment = createFragmentNode(startNode, null, parentNode);
    fragment.___finishFragment = function(nextNode) {
        fragment.___finishFragment = null;
        insertBefore(
            fragment.endNode,
            nextNode,
            parentNode || startNode.parentNode
        );
    };
    return fragment;
}

exports.___createFragmentNode = createFragmentNode;
exports.___beginFragmentNode = beginFragmentNode;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/VFragment", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"../components/dom-data"*/);
var keysByDOMNode = domData.___keyByDOMNode;
var vElementByDOMNode = domData.___vElementByDOMNode;
var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var createFragmentNode = require('/marko$4.18.39/src/runtime/vdom/morphdom/fragment'/*"./morphdom/fragment"*/).___createFragmentNode;

function VFragment(key, ownerComponent, preserve) {
    this.___VNode(null /* childCount */);
    this.___key = key;
    this.___ownerComponent = ownerComponent;
    this.___preserve = preserve;
}

VFragment.prototype = {
    ___nodeType: 12,
    ___actualize: function() {
        var fragment = createFragmentNode();
        keysByDOMNode.set(fragment, this.___key);
        vElementByDOMNode.set(fragment, this);
        return fragment;
    }
};

inherit(VFragment, VNode);

module.exports = VFragment;

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.18.39/src/runtime/vdom/VNode'/*"./VNode"*/);
var VComment = require('/marko$4.18.39/src/runtime/vdom/VComment'/*"./VComment"*/);
var VDocumentFragment = require('/marko$4.18.39/src/runtime/vdom/VDocumentFragment'/*"./VDocumentFragment"*/);
var VElement = require('/marko$4.18.39/src/runtime/vdom/VElement'/*"./VElement"*/);
var VText = require('/marko$4.18.39/src/runtime/vdom/VText'/*"./VText"*/);
var VComponent = require('/marko$4.18.39/src/runtime/vdom/VComponent'/*"./VComponent"*/);
var VFragment = require('/marko$4.18.39/src/runtime/vdom/VFragment'/*"./VFragment"*/);

var defaultDocument = typeof document != "undefined" && document;
var specialHtmlRegexp = /[&<]/;

function virtualizeChildNodes(node, vdomParent) {
    var curChild = node.firstChild;
    while (curChild) {
        vdomParent.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }
}

function virtualize(node) {
    switch (node.nodeType) {
        case 1:
            return VElement.___virtualize(node, virtualizeChildNodes);
        case 3:
            return new VText(node.nodeValue);
        case 8:
            return new VComment(node.nodeValue);
        case 11:
            var vdomDocFragment = new VDocumentFragment();
            virtualizeChildNodes(node, vdomDocFragment);
            return vdomDocFragment;
    }
}

function virtualizeHTML(html, doc) {
    if (!specialHtmlRegexp.test(html)) {
        return new VText(html);
    }

    var container = doc.createElement("body");
    container.innerHTML = html;
    var vdomFragment = new VDocumentFragment();

    var curChild = container.firstChild;
    while (curChild) {
        vdomFragment.___appendChild(virtualize(curChild));
        curChild = curChild.nextSibling;
    }

    return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function(value) {
    var type = typeof value;
    var vdomNode;

    if (type !== "string") {
        if (value == null) {
            value = "";
        } else if (type === "object") {
            if (value.toHTML) {
                vdomNode = virtualizeHTML(value.toHTML(), document);
            }
        }
    }

    this.___appendChild(vdomNode || new VText(value.toString()));
    return this.___finishChild();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function(value) {
    this.___appendChild(new VComment(value));
    return this.___finishChild();
};

Node_prototype.___appendDocumentFragment = function() {
    return this.___appendChild(new VDocumentFragment());
};

exports.___VComment = VComment;
exports.___VDocumentFragment = VDocumentFragment;
exports.___VElement = VElement;
exports.___VText = VText;
exports.___VComponent = VComponent;
exports.___VFragment = VFragment;
exports.___virtualize = virtualize;
exports.___virtualizeHTML = virtualizeHTML;
exports.___defaultDocument = defaultDocument;

});
$_mod.remap("/marko$4.18.39/src/runtime/components/util", "/marko$4.18.39/src/runtime/components/util-browser");
$_mod.def("/marko$4.18.39/src/runtime/components/util-browser", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.___componentByDOMNode;
var keysByDOMNode = domData.___keyByDOMNode;
var vElementsByDOMNode = domData.___vElementByDOMNode;
var vPropsByDOMNode = domData.___vPropsByDOMNode;
var markoUID = window.$MUID || (window.$MUID = { i: 0 });
var runtimeId = markoUID.i++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getComponentForEl(el, doc) {
    var node =
        typeof el == "string"
            ? (doc || defaultDocument).getElementById(el)
            : el;
    var component;
    var vElement;

    while (node) {
        if (node.fragment) {
            if (node.fragment.endNode === node) {
                node = node.fragment.startNode;
            } else {
                node = node.fragment;
                component = componentsByDOMNode.get(node);
            }
        } else if ((vElement = vElementsByDOMNode.get(node))) {
            component = vElement.___ownerComponent;
        }

        if (component) {
            return component;
        }

        node = node.previousSibling || node.parentNode;
    }
}

var lifecycleEventMethods = {};

["create", "render", "update", "mount", "destroy"].forEach(function(eventName) {
    lifecycleEventMethods[eventName] =
        "on" + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
    var listenerMethod = component[lifecycleEventMethods[eventType]];

    if (listenerMethod !== undefined) {
        listenerMethod.call(component, eventArg1, eventArg2);
    }

    component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForNode(node) {
    var componentToDestroy = componentsByDOMNode.get(node.fragment || node);
    if (componentToDestroy) {
        componentToDestroy.___destroyShallow();
        delete componentLookup[componentToDestroy.id];
    }
}
function destroyNodeRecursive(node, component) {
    destroyComponentForNode(node);
    if (node.nodeType === 1 || node.nodeType === 12) {
        var key;

        if (component && (key = keysByDOMNode.get(node))) {
            if (node === component.___keyedElements[key]) {
                if (componentsByDOMNode.get(node) && /\[\]$/.test(key)) {
                    delete component.___keyedElements[key][
                        componentsByDOMNode.get(node).id
                    ];
                } else {
                    delete component.___keyedElements[key];
                }
            }
        }

        var curChild = node.firstChild;
        while (curChild && curChild !== node.endNode) {
            destroyNodeRecursive(curChild, component);
            curChild = curChild.nextSibling;
        }
    }
}

function nextComponentId() {
    // Each component will get an ID that is unique across all loaded
    // marko runtimes. This allows multiple instances of marko to be
    // loaded in the same window and they should all place nice
    // together
    return "c" + markoUID.i++;
}

function nextComponentIdProvider() {
    return nextComponentId;
}

function attachBubblingEvent(
    componentDef,
    handlerMethodName,
    isOnce,
    extraArgs
) {
    if (handlerMethodName) {
        var componentId = componentDef.id;
        if (extraArgs) {
            return [handlerMethodName, componentId, isOnce, extraArgs];
        } else {
            return [handlerMethodName, componentId, isOnce];
        }
    }
}

function getMarkoPropsFromEl(el) {
    var vElement = vElementsByDOMNode.get(el);
    var virtualProps;

    if (vElement) {
        virtualProps = vElement.___properties;
    } else {
        virtualProps = vPropsByDOMNode.get(el);
        if (!virtualProps) {
            virtualProps = el.getAttribute("data-marko");
            vPropsByDOMNode.set(
                el,
                (virtualProps = virtualProps
                    ? JSON.parse(virtualProps)
                    : EMPTY_OBJECT)
            );
        }
    }

    return virtualProps;
}

function normalizeComponentKey(key, parentId) {
    if (key[0] === "#") {
        key = key.replace("#" + parentId + "-", "");
    }
    return key;
}

function addComponentRootToKeyedElements(
    keyedElements,
    key,
    rootNode,
    componentId
) {
    if (/\[\]$/.test(key)) {
        var repeatedElementsForKey = (keyedElements[key] =
            keyedElements[key] || {});
        repeatedElementsForKey[componentId] = rootNode;
    } else {
        keyedElements[key] = rootNode;
    }
}

exports.___runtimeId = runtimeId;
exports.___componentLookup = componentLookup;
exports.___getComponentForEl = getComponentForEl;
exports.___emitLifecycleEvent = emitLifecycleEvent;
exports.___destroyComponentForNode = destroyComponentForNode;
exports.___destroyNodeRecursive = destroyNodeRecursive;
exports.___nextComponentIdProvider = nextComponentIdProvider;
exports.___attachBubblingEvent = attachBubblingEvent;
exports.___getMarkoPropsFromEl = getMarkoPropsFromEl;
exports.___addComponentRootToKeyedElements = addComponentRootToKeyedElements;
exports.___normalizeComponentKey = normalizeComponentKey;

});
$_mod.def("/marko$4.18.39/src/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./components/util"*/);
var destroyComponentForNode = componentsUtil.___destroyComponentForNode;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;
var helpers = require('/marko$4.18.39/src/runtime/vdom/morphdom/helpers'/*"./vdom/morphdom/helpers"*/);

var insertBefore = helpers.___insertBefore;
var insertAfter = helpers.___insertAfter;
var removeChild = helpers.___removeChild;

function resolveEl(el) {
    if (typeof el == "string") {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw Error("Not found: " + elId);
        }
    }
    return el;
}

function beforeRemove(referenceEl) {
    destroyNodeRecursive(referenceEl);
    destroyComponentForNode(referenceEl);
}

module.exports = function(target, getEl, afterInsert) {
    extend(target, {
        appendTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        prependTo: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl.firstChild || null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        replace: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            beforeRemove(referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            removeChild(referenceEl);
            return afterInsert(this, referenceEl);
        },
        replaceChildrenOf: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);

            var curChild = referenceEl.firstChild;
            while (curChild) {
                var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
                beforeRemove(curChild);
                curChild = nextSibling;
            }

            referenceEl.innerHTML = "";
            insertBefore(el, null, referenceEl);
            return afterInsert(this, referenceEl);
        },
        insertBefore: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertBefore(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        },
        insertAfter: function(referenceEl) {
            referenceEl = resolveEl(referenceEl);
            var el = getEl(this, referenceEl);
            insertAfter(el, referenceEl, referenceEl.parentNode);
            return afterInsert(this, referenceEl);
        }
    });
};

});
$_mod.installed("marko$4.18.39", "complain", "1.6.0");
$_mod.main("/complain$1.6.0", "");
$_mod.installed("complain$1.6.0", "process", "0.11.10");
$_mod.main("/process$0.11.10", "");
$_mod.remap("/process$0.11.10/index", "/process$0.11.10/browser");
$_mod.def("/process$0.11.10/browser", function(require, exports, module, __filename, __dirname) { // shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

});
$_mod.installed("complain$1.6.0", "error-stack-parser", "2.0.6");
$_mod.main("/error-stack-parser$2.0.6", "error-stack-parser");
$_mod.installed("error-stack-parser$2.0.6", "stackframe", "1.1.1");
$_mod.main("/stackframe$1.1.1", "stackframe");
$_mod.def("/stackframe$1.1.1/stackframe", function(require, exports, module, __filename, __dirname) { (function(root, factory) {
    'use strict';
    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

    /* istanbul ignore next */
    if (typeof define === 'function' && define.amd) {
        define('stackframe', [], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        root.StackFrame = factory();
    }
}(this, function() {
    'use strict';
    function _isNumber(n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
    }

    function _capitalize(str) {
        return str.charAt(0).toUpperCase() + str.substring(1);
    }

    function _getter(p) {
        return function() {
            return this[p];
        };
    }

    var booleanProps = ['isConstructor', 'isEval', 'isNative', 'isToplevel'];
    var numericProps = ['columnNumber', 'lineNumber'];
    var stringProps = ['fileName', 'functionName', 'source'];
    var arrayProps = ['args'];

    var props = booleanProps.concat(numericProps, stringProps, arrayProps);

    function StackFrame(obj) {
        if (!obj) return;
        for (var i = 0; i < props.length; i++) {
            if (obj[props[i]] !== undefined) {
                this['set' + _capitalize(props[i])](obj[props[i]]);
            }
        }
    }

    StackFrame.prototype = {
        getArgs: function() {
            return this.args;
        },
        setArgs: function(v) {
            if (Object.prototype.toString.call(v) !== '[object Array]') {
                throw new TypeError('Args must be an Array');
            }
            this.args = v;
        },

        getEvalOrigin: function() {
            return this.evalOrigin;
        },
        setEvalOrigin: function(v) {
            if (v instanceof StackFrame) {
                this.evalOrigin = v;
            } else if (v instanceof Object) {
                this.evalOrigin = new StackFrame(v);
            } else {
                throw new TypeError('Eval Origin must be an Object or StackFrame');
            }
        },

        toString: function() {
            var fileName = this.getFileName() || '';
            var lineNumber = this.getLineNumber() || '';
            var columnNumber = this.getColumnNumber() || '';
            var functionName = this.getFunctionName() || '';
            if (this.getIsEval()) {
                if (fileName) {
                    return '[eval] (' + fileName + ':' + lineNumber + ':' + columnNumber + ')';
                }
                return '[eval]:' + lineNumber + ':' + columnNumber;
            }
            if (functionName) {
                return functionName + ' (' + fileName + ':' + lineNumber + ':' + columnNumber + ')';
            }
            return fileName + ':' + lineNumber + ':' + columnNumber;
        }
    };

    StackFrame.fromString = function StackFrame$$fromString(str) {
        var argsStartIndex = str.indexOf('(');
        var argsEndIndex = str.lastIndexOf(')');

        var functionName = str.substring(0, argsStartIndex);
        var args = str.substring(argsStartIndex + 1, argsEndIndex).split(',');
        var locationString = str.substring(argsEndIndex + 1);

        if (locationString.indexOf('@') === 0) {
            var parts = /@(.+?)(?::(\d+))?(?::(\d+))?$/.exec(locationString, '');
            var fileName = parts[1];
            var lineNumber = parts[2];
            var columnNumber = parts[3];
        }

        return new StackFrame({
            functionName: functionName,
            args: args || undefined,
            fileName: fileName,
            lineNumber: lineNumber || undefined,
            columnNumber: columnNumber || undefined
        });
    };

    for (var i = 0; i < booleanProps.length; i++) {
        StackFrame.prototype['get' + _capitalize(booleanProps[i])] = _getter(booleanProps[i]);
        StackFrame.prototype['set' + _capitalize(booleanProps[i])] = (function(p) {
            return function(v) {
                this[p] = Boolean(v);
            };
        })(booleanProps[i]);
    }

    for (var j = 0; j < numericProps.length; j++) {
        StackFrame.prototype['get' + _capitalize(numericProps[j])] = _getter(numericProps[j]);
        StackFrame.prototype['set' + _capitalize(numericProps[j])] = (function(p) {
            return function(v) {
                if (!_isNumber(v)) {
                    throw new TypeError(p + ' must be a Number');
                }
                this[p] = Number(v);
            };
        })(numericProps[j]);
    }

    for (var k = 0; k < stringProps.length; k++) {
        StackFrame.prototype['get' + _capitalize(stringProps[k])] = _getter(stringProps[k]);
        StackFrame.prototype['set' + _capitalize(stringProps[k])] = (function(p) {
            return function(v) {
                this[p] = String(v);
            };
        })(stringProps[k]);
    }

    return StackFrame;
}));

});
$_mod.def("/error-stack-parser$2.0.6/error-stack-parser", function(require, exports, module, __filename, __dirname) { (function(root, factory) {
    'use strict';
    // Universal Module Definition (UMD) to support AMD, CommonJS/Node.js, Rhino, and browsers.

    /* istanbul ignore next */
    if (typeof define === 'function' && define.amd) {
        define('error-stack-parser', ['stackframe'], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory(require('/stackframe$1.1.1/stackframe'/*'stackframe'*/));
    } else {
        root.ErrorStackParser = factory(root.StackFrame);
    }
}(this, function ErrorStackParser(StackFrame) {
    'use strict';

    var FIREFOX_SAFARI_STACK_REGEXP = /(^|@)\S+:\d+/;
    var CHROME_IE_STACK_REGEXP = /^\s*at .*(\S+:\d+|\(native\))/m;
    var SAFARI_NATIVE_CODE_REGEXP = /^(eval@)?(\[native code])?$/;

    return {
        /**
         * Given an Error object, extract the most information from it.
         *
         * @param {Error} error object
         * @return {Array} of StackFrames
         */
        parse: function ErrorStackParser$$parse(error) {
            if (typeof error.stacktrace !== 'undefined' || typeof error['opera#sourceloc'] !== 'undefined') {
                return this.parseOpera(error);
            } else if (error.stack && error.stack.match(CHROME_IE_STACK_REGEXP)) {
                return this.parseV8OrIE(error);
            } else if (error.stack) {
                return this.parseFFOrSafari(error);
            } else {
                throw new Error('Cannot parse given Error object');
            }
        },

        // Separate line and column numbers from a string of the form: (URI:Line:Column)
        extractLocation: function ErrorStackParser$$extractLocation(urlLike) {
            // Fail-fast but return locations like "(native)"
            if (urlLike.indexOf(':') === -1) {
                return [urlLike];
            }

            var regExp = /(.+?)(?::(\d+))?(?::(\d+))?$/;
            var parts = regExp.exec(urlLike.replace(/[()]/g, ''));
            return [parts[1], parts[2] || undefined, parts[3] || undefined];
        },

        parseV8OrIE: function ErrorStackParser$$parseV8OrIE(error) {
            var filtered = error.stack.split('\n').filter(function(line) {
                return !!line.match(CHROME_IE_STACK_REGEXP);
            }, this);

            return filtered.map(function(line) {
                if (line.indexOf('(eval ') > -1) {
                    // Throw away eval information until we implement stacktrace.js/stackframe#8
                    line = line.replace(/eval code/g, 'eval').replace(/(\(eval at [^()]*)|(\),.*$)/g, '');
                }
                var sanitizedLine = line.replace(/^\s+/, '').replace(/\(eval code/g, '(');

                // capture and preseve the parenthesized location "(/foo/my bar.js:12:87)" in
                // case it has spaces in it, as the string is split on \s+ later on
                var location = sanitizedLine.match(/ (\((.+):(\d+):(\d+)\)$)/);

                // remove the parenthesized location from the line, if it was matched
                sanitizedLine = location ? sanitizedLine.replace(location[0], '') : sanitizedLine;

                var tokens = sanitizedLine.split(/\s+/).slice(1);
                // if a location was matched, pass it to extractLocation() otherwise pop the last token
                var locationParts = this.extractLocation(location ? location[1] : tokens.pop());
                var functionName = tokens.join(' ') || undefined;
                var fileName = ['eval', '<anonymous>'].indexOf(locationParts[0]) > -1 ? undefined : locationParts[0];

                return new StackFrame({
                    functionName: functionName,
                    fileName: fileName,
                    lineNumber: locationParts[1],
                    columnNumber: locationParts[2],
                    source: line
                });
            }, this);
        },

        parseFFOrSafari: function ErrorStackParser$$parseFFOrSafari(error) {
            var filtered = error.stack.split('\n').filter(function(line) {
                return !line.match(SAFARI_NATIVE_CODE_REGEXP);
            }, this);

            return filtered.map(function(line) {
                // Throw away eval information until we implement stacktrace.js/stackframe#8
                if (line.indexOf(' > eval') > -1) {
                    line = line.replace(/ line (\d+)(?: > eval line \d+)* > eval:\d+:\d+/g, ':$1');
                }

                if (line.indexOf('@') === -1 && line.indexOf(':') === -1) {
                    // Safari eval frames only have function names and nothing else
                    return new StackFrame({
                        functionName: line
                    });
                } else {
                    var functionNameRegex = /((.*".+"[^@]*)?[^@]*)(?:@)/;
                    var matches = line.match(functionNameRegex);
                    var functionName = matches && matches[1] ? matches[1] : undefined;
                    var locationParts = this.extractLocation(line.replace(functionNameRegex, ''));

                    return new StackFrame({
                        functionName: functionName,
                        fileName: locationParts[0],
                        lineNumber: locationParts[1],
                        columnNumber: locationParts[2],
                        source: line
                    });
                }
            }, this);
        },

        parseOpera: function ErrorStackParser$$parseOpera(e) {
            if (!e.stacktrace || (e.message.indexOf('\n') > -1 &&
                e.message.split('\n').length > e.stacktrace.split('\n').length)) {
                return this.parseOpera9(e);
            } else if (!e.stack) {
                return this.parseOpera10(e);
            } else {
                return this.parseOpera11(e);
            }
        },

        parseOpera9: function ErrorStackParser$$parseOpera9(e) {
            var lineRE = /Line (\d+).*script (?:in )?(\S+)/i;
            var lines = e.message.split('\n');
            var result = [];

            for (var i = 2, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(new StackFrame({
                        fileName: match[2],
                        lineNumber: match[1],
                        source: lines[i]
                    }));
                }
            }

            return result;
        },

        parseOpera10: function ErrorStackParser$$parseOpera10(e) {
            var lineRE = /Line (\d+).*script (?:in )?(\S+)(?:: In function (\S+))?$/i;
            var lines = e.stacktrace.split('\n');
            var result = [];

            for (var i = 0, len = lines.length; i < len; i += 2) {
                var match = lineRE.exec(lines[i]);
                if (match) {
                    result.push(
                        new StackFrame({
                            functionName: match[3] || undefined,
                            fileName: match[2],
                            lineNumber: match[1],
                            source: lines[i]
                        })
                    );
                }
            }

            return result;
        },

        // Opera 10.65+ Error.stack very similar to FF/Safari
        parseOpera11: function ErrorStackParser$$parseOpera11(error) {
            var filtered = error.stack.split('\n').filter(function(line) {
                return !!line.match(FIREFOX_SAFARI_STACK_REGEXP) && !line.match(/^Error created at/);
            }, this);

            return filtered.map(function(line) {
                var tokens = line.split('@');
                var locationParts = this.extractLocation(tokens.pop());
                var functionCall = (tokens.shift() || '');
                var functionName = functionCall
                    .replace(/<anonymous function(: (\w+))?>/, '$2')
                    .replace(/\([^)]*\)/g, '') || undefined;
                var argsRaw;
                if (functionCall.match(/\(([^)]*)\)/)) {
                    argsRaw = functionCall.replace(/^[^(]+\(([^)]*)\)$/, '$1');
                }
                var args = (argsRaw === undefined || argsRaw === '[arguments not available]') ?
                    undefined : argsRaw.split(',');

                return new StackFrame({
                    functionName: functionName,
                    args: args,
                    fileName: locationParts[0],
                    lineNumber: locationParts[1],
                    columnNumber: locationParts[2],
                    source: line
                });
            }, this);
        }
    };
}));

});
$_mod.def("/complain$1.6.0/index", function(require, exports, module, __filename, __dirname) { 'use strict';var process=require("process"); 

var StackParser = require('/error-stack-parser$2.0.6/error-stack-parser'/*'error-stack-parser'*/);
var env = typeof process !== 'undefined' && process.env.NODE_ENV;
var isDevelopment = !env || env === 'dev' || env === 'development';
var showModuleComplains = typeof process !== 'undefined' && Boolean(process.env.SHOW_MODULE_COMPLAINS);
var showNestedComplains = typeof process !== 'undefined' && Boolean(process.env.SHOW_NESTED_COMPLAINS);
var logger = typeof console !== 'undefined' && console.warn && console;
var cwd = typeof process !== 'undefined' && process.cwd() + '/' || '';
var linebreak = typeof process !== 'undefined' && 'win32' === process.platform ? '\r\n' : '\n';
var newline = /(\r\n|\r|\n)/g;
var slice = [].slice;
var ignoredLocation = "[ignore]";
var hits = {};

complain = isDevelopment ? complain : noop;
complain.method = isDevelopment ? method : noop;
complain.fn = isDevelopment ? fn : noopReturn;
complain.log = log;
complain.stream = typeof process !== 'undefined' && process.stderr;
complain.silence = false;
complain.color = complain.stream && complain.stream.isTTY;
complain.colors = { warning:'\x1b[31;1m', notice:'\x1b[33;1m', message:false, location:'\u001b[90m' };
complain.getModuleName = getModuleName;

/* istanbul ignore next */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = complain;
} else if(typeof window !== 'undefined') {
  window.complain = complain;
}

function complain() {
  var options;
  var location;
  var locationIndex;
  var headingColor;
  var heading;
  var level;
  var args = arguments;

  if(complain.silence) return;

  if(typeof args[args.length-1] === 'object') {
    options = args[args.length-1];
    args = slice.call(args, 0, -1);
  } else {
    options = {};
  }

  level = options.level || 2;
  heading = options.heading || (level == 2 ? "WARNING!!" : "NOTICE");
  headingColor = options.headingColor || (level == 2 ? complain.colors.warning : complain.colors.notice);

  // Default to the location of the call to the deprecated function
  locationIndex = options.locationIndex == null ? 1 : options.locationIndex;

  // When the user sets location to false,
  // We will use the location of the call to complain()
  // To limit the log to only occurring once
  if(options.location === false) {
    locationIndex = 0;
  }

  location = options.location || getLocation(locationIndex);
  
  var moduleName = complain.getModuleName(location);

  if (moduleName && !showModuleComplains) {
    if (!hits[moduleName]) {
      var output = format("NOTICE", complain.colors.notice);
      output += linebreak + format('The module ['+moduleName+'] is using deprecated features.', complain.colors.message);
      output += linebreak + format('Run with process.env.SHOW_MODULE_COMPLAINS=1 to see all warnings.', complain.colors.message);
      complain.log(linebreak + output + linebreak);
      hits[moduleName] = true;
    }
    return;
  }

  /* istanbul ignore next */
  // Location is only missing in older browsers.
  if(location) {
    if(hits[location] || location === ignoredLocation) return;
    else hits[location] = true;
  }

  var output = format(heading, headingColor);

  for(var i = 0; i < args.length; i++) {
    output += linebreak + format(args[i], complain.colors.message);
  }

  if(options.location !== false && location) {
    output += linebreak + format('  at '+location.replace(cwd, ''), complain.colors.location);
  }

  complain.log(linebreak + output + linebreak);
};

function method(object, methodName) {
    var originalMethod = object[methodName];
    var args = slice.call(arguments, 2);

    object[methodName] = function() {
        complain.apply(null, args);
        return originalMethod.apply(this, arguments);
    };
}

function fn(original) {
  var args = slice.call(arguments, 1);

  return function() {
    complain.apply(null, args);
    return original.apply(this, arguments);
  }
}

function log(message, color) {
  var formatted = format(message, color);
  if(complain.stream) {
    complain.stream.write(formatted+linebreak);
  } else if(logger) {
    logger.warn(formatted);
  }
}

function format(message, color) {
  return color && complain.color ? color + message + '\x1b[0m' : message;
}

function getLocation(locationIndex) {
  var location = '';
  var targetIndex = locationIndex + 2;

  /**
   * Stack index descriptions.
   * 
   * 0: In getLocation(), the call to new Error()
   * 1: In complain(), the call to getLocation()
   * 2: In the deprecated function, the call to complain()
   * 3: The call to the deprecated function (THIS IS THE DEFAULT)
   */

  try {
    var locations = StackParser.parse(new Error()).map(function(frame) {
      return frame.fileName+':'+frame.lineNumber+':'+frame.columnNumber;
    });
    if (!showNestedComplains) {
      for (var i = locations.length-1; i > targetIndex; i--) {
        if (hits[locations[i]]) {
          return ignoredLocation;
        }
      }
    }
    location = locations[targetIndex];
  } catch(e) {}

  return location;
}

function getModuleName(location) {
  var locationParts = location.replace(cwd, '').split(/\/|\\/g);
  for(var i = locationParts.length-1; i >= 0; i--) {
    if (locationParts[i] === 'node_modules') {
      var moduleName = locationParts[i+1];
      return (moduleName[0] === '@') ? moduleName+'/'+locationParts[i+2] : moduleName;
    }
  }
}

function noop(){};
function noopReturn(r) { return r; };

});
$_mod.def("/marko$4.18.39/src/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.18.39/src/runtime/dom-insert'/*"./dom-insert"*/);
var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);

function getComponentDefs(result) {
    var componentDefs = result.___components;

    if (!componentDefs) {
        throw Error("No component");
    }
    return componentDefs;
}

function RenderResult(out) {
    this.out = this.___out = out;
    this.___components = undefined;
}

module.exports = RenderResult;

var proto = (RenderResult.prototype = {
    getComponent: function() {
        return this.getComponents()[0];
    },
    getComponents: function(selector) {
        if (this.___components === undefined) {
            throw Error("Not added to DOM");
        }

        var componentDefs = getComponentDefs(this);

        var components = [];

        componentDefs.forEach(function(componentDef) {
            var component = componentDef.___component;
            if (!selector || selector(component)) {
                components.push(component);
            }
        });

        return components;
    },

    afterInsert: function(doc) {
        var out = this.___out;
        var componentsContext = out.___components;
        if (componentsContext) {
            this.___components = componentsContext.___initComponents(doc);
        } else {
            this.___components = null;
        }

        return this;
    },
    getNode: function(doc) {
        return this.___out.___getNode(doc);
    },
    getOutput: function() {
        return this.___out.___getOutput();
    },
    toString: function() {
        return this.___out.toString();
    },
    document: typeof document != "undefined" && document
});

Object.defineProperty(proto, "html", {
    get: function() {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                'The "html" property is deprecated. Please use "toString" instead.'
            );
        }
        return this.toString();
    }
});

Object.defineProperty(proto, "context", {
    get: function() {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                'The "context" property is deprecated. Please use "out" instead.'
            );
        }
        return this.___out;
    }
});

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    proto,
    function getEl(renderResult, referenceEl) {
        return renderResult.getNode(referenceEl.ownerDocument);
    },
    function afterInsert(renderResult, referenceEl) {
        var isShadow =
            typeof ShadowRoot === "function" &&
            referenceEl instanceof ShadowRoot;
        return renderResult.afterInsert(
            isShadow ? referenceEl : referenceEl.ownerDocument
        );
    }
);

});
$_mod.main("/marko$4.18.39/src/runtime/vdom/morphdom", "");
$_mod.def("/marko$4.18.39/src/runtime/vdom/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
    if (fromEl[name] !== toEl[name]) {
        fromEl[name] = toEl[name];
        if (fromEl[name]) {
            fromEl.setAttribute(name, "");
        } else {
            fromEl.removeAttribute(name, "");
        }
    }
}

function forEachOption(el, fn, i) {
    var curChild = el.___firstChild;

    while (curChild) {
        if (curChild.___nodeName === "option") {
            fn(curChild, ++i);
        } else {
            i = forEachOption(curChild, fn, i);
        }

        curChild = curChild.___nextSibling;
    }

    return i;
}

// We use a JavaScript class to benefit from fast property lookup
function SpecialElHandlers() {}
SpecialElHandlers.prototype = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    option: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "selected");
    },
    button: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "disabled");
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    input: function(fromEl, toEl) {
        syncBooleanAttrProp(fromEl, toEl, "checked");
        syncBooleanAttrProp(fromEl, toEl, "disabled");

        if (fromEl.value != toEl.___value) {
            fromEl.value = toEl.___value;
        }

        if (fromEl.hasAttribute("value") && !toEl.___hasAttribute("value")) {
            fromEl.removeAttribute("value");
        }
    },

    textarea: function(fromEl, toEl) {
        if (toEl.___preserveTextAreaValue) {
            return;
        }

        var newValue = toEl.___value;
        if (fromEl.value != newValue) {
            fromEl.value = newValue;
        }

        var firstChild = fromEl.firstChild;
        if (firstChild) {
            // Needed for IE. Apparently IE sets the placeholder as the
            // node value and vise versa. This ignores an empty update.
            var oldValue = firstChild.nodeValue;

            if (
                oldValue == newValue ||
                (!newValue && oldValue == fromEl.placeholder)
            ) {
                return;
            }

            firstChild.nodeValue = newValue;
        }
    },
    select: function(fromEl, toEl) {
        if (!toEl.___hasAttribute("multiple")) {
            var selected = 0;
            forEachOption(
                toEl,
                function(option, i) {
                    if (option.___hasAttribute("selected")) {
                        selected = i;
                    }
                },
                -1
            );

            if (fromEl.selectedIndex !== selected) {
                fromEl.selectedIndex = selected;
            }
        }
    }
};

module.exports = new SpecialElHandlers();

});
$_mod.def("/marko$4.18.39/src/runtime/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var runtimeId = componentsUtil.___runtimeId;
var componentLookup = componentsUtil.___componentLookup;
var getMarkoPropsFromEl = componentsUtil.___getMarkoPropsFromEl;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = "$MDE" + runtimeId;
var delegatedEvents = {};

function getEventFromEl(el, eventName) {
    var virtualProps = getMarkoPropsFromEl(el);
    var eventInfo = virtualProps[eventName];

    if (typeof eventInfo === "string") {
        eventInfo = eventInfo.split(" ");
        if (eventInfo[2]) {
            eventInfo[2] = eventInfo[2] === "true";
        }
        if (eventInfo.length == 4) {
            eventInfo[3] = parseInt(eventInfo[3], 10);
        }
    }

    return eventInfo;
}

function delegateEvent(node, eventName, target, event) {
    var targetMethod = target[0];
    var targetComponentId = target[1];
    var isOnce = target[2];
    var extraArgs = target[3];

    if (isOnce) {
        var virtualProps = getMarkoPropsFromEl(node);
        delete virtualProps[eventName];
    }

    var targetComponent = componentLookup[targetComponentId];

    if (!targetComponent) {
        return;
    }

    var targetFunc =
        typeof targetMethod === "function"
            ? targetMethod
            : targetComponent[targetMethod];
    if (!targetFunc) {
        throw Error("Method not found: " + targetMethod);
    }

    if (extraArgs != null) {
        if (typeof extraArgs === "number") {
            extraArgs = targetComponent.___bubblingDomEvents[extraArgs];
        }
    }

    // Invoke the component method
    if (extraArgs) {
        targetFunc.apply(targetComponent, extraArgs.concat(event, node));
    } else {
        targetFunc.call(targetComponent, event, node);
    }
}

function addDelegatedEventHandler(eventType) {
    if (!delegatedEvents[eventType]) {
        delegatedEvents[eventType] = true;
    }
}

function addDelegatedEventHandlerToDoc(eventType, doc) {
    var body = doc.body || doc;
    var listeners = (doc[listenersAttachedKey] =
        doc[listenersAttachedKey] || {});
    if (!listeners[eventType]) {
        body.addEventListener(
            eventType,
            (listeners[eventType] = function(event) {
                var propagationStopped = false;

                // Monkey-patch to fix #97
                var oldStopPropagation = event.stopPropagation;

                event.stopPropagation = function() {
                    oldStopPropagation.call(event);
                    propagationStopped = true;
                };

                var curNode = event.target;
                if (!curNode) {
                    return;
                }

                // event.target of an SVGElementInstance does not have a
                // `getAttribute` function in IE 11.
                // See https://github.com/marko-js/marko/issues/796
                curNode = curNode.correspondingUseElement || curNode;

                // Search up the tree looking DOM events mapped to target
                // component methods
                var propName = "on" + eventType;
                var target;

                // Attributes will have the following form:
                // on<event_type>("<target_method>|<component_id>")

                do {
                    if ((target = getEventFromEl(curNode, propName))) {
                        delegateEvent(curNode, propName, target, event);

                        if (propagationStopped) {
                            break;
                        }
                    }
                } while (
                    (curNode = curNode.parentNode) &&
                    curNode.getAttribute
                );
            }),
            true
        );
    }
}

function noop() {}

exports.___handleNodeAttach = noop;
exports.___handleNodeDetach = noop;
exports.___delegateEvent = delegateEvent;
exports.___getEventFromEl = getEventFromEl;
exports.___addDelegatedEventHandler = addDelegatedEventHandler;
exports.___init = function(doc) {
    Object.keys(delegatedEvents).forEach(function(eventType) {
        addDelegatedEventHandlerToDoc(eventType, doc);
    });
};

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/morphdom/index", function(require, exports, module, __filename, __dirname) { "use strict";
var specialElHandlers = require('/marko$4.18.39/src/runtime/vdom/morphdom/specialElHandlers'/*"./specialElHandlers"*/);
var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"../../components/util"*/);
var existingComponentLookup = componentsUtil.___componentLookup;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;
var addComponentRootToKeyedElements =
    componentsUtil.___addComponentRootToKeyedElements;
var normalizeComponentKey = componentsUtil.___normalizeComponentKey;
var VElement = require('/marko$4.18.39/src/runtime/vdom/vdom'/*"../vdom"*/).___VElement;
var virtualizeElement = VElement.___virtualize;
var morphAttrs = VElement.___morphAttrs;
var eventDelegation = require('/marko$4.18.39/src/runtime/components/event-delegation'/*"../../components/event-delegation"*/);
var fragment = require('/marko$4.18.39/src/runtime/vdom/morphdom/fragment'/*"./fragment"*/);
var helpers = require('/marko$4.18.39/src/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"../../components/dom-data"*/);
var keysByDOMNode = domData.___keyByDOMNode;
var componentByDOMNode = domData.___componentByDOMNode;
var vElementByDOMNode = domData.___vElementByDOMNode;
var detachedByDOMNode = domData.___detachedByDOMNode;

var insertBefore = helpers.___insertBefore;
var insertAfter = helpers.___insertAfter;
var nextSibling = helpers.___nextSibling;
var firstChild = helpers.___firstChild;
var removeChild = helpers.___removeChild;
var createFragmentNode = fragment.___createFragmentNode;
var beginFragmentNode = fragment.___beginFragmentNode;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var COMPONENT_NODE = 2;
var FRAGMENT_NODE = 12;
var DOCTYPE_NODE = 10;

// var FLAG_SIMPLE_ATTRS = 1;
// var FLAG_CUSTOM_ELEMENT = 2;

function isAutoKey(key) {
    return !/^@/.test(key);
}

function compareNodeNames(fromEl, toEl) {
    return fromEl.___nodeName === toEl.___nodeName;
}

function caseInsensitiveCompare(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}

function onNodeAdded(node, componentsContext) {
    if (node.nodeType === 1) {
        eventDelegation.___handleNodeAttach(node, componentsContext);
    }
}

function morphdom(fromNode, toNode, doc, componentsContext) {
    var globalComponentsContext;
    var isHydrate = false;
    var keySequences = {};

    if (componentsContext) {
        globalComponentsContext = componentsContext.___globalContext;
        isHydrate = globalComponentsContext.___isHydrate;
    }

    function insertVirtualNodeBefore(
        vNode,
        key,
        referenceEl,
        parentEl,
        ownerComponent,
        parentComponent
    ) {
        var realNode = vNode.___actualize(doc, parentEl.namespaceURI);
        insertBefore(realNode, referenceEl, parentEl);

        if (
            vNode.___nodeType === ELEMENT_NODE ||
            vNode.___nodeType === FRAGMENT_NODE
        ) {
            if (key) {
                keysByDOMNode.set(realNode, key);
                (isAutoKey(key)
                    ? parentComponent
                    : ownerComponent
                ).___keyedElements[key] = realNode;
            }

            morphChildren(realNode, vNode, parentComponent);
        }

        onNodeAdded(realNode, componentsContext);
    }

    function insertVirtualComponentBefore(
        vComponent,
        referenceNode,
        referenceNodeParentEl,
        component,
        key,
        ownerComponent,
        parentComponent
    ) {
        var rootNode = (component.___rootNode = insertBefore(
            createFragmentNode(),
            referenceNode,
            referenceNodeParentEl
        ));
        componentByDOMNode.set(rootNode, component);

        if (key && ownerComponent) {
            key = normalizeComponentKey(key, parentComponent.id);
            addComponentRootToKeyedElements(
                ownerComponent.___keyedElements,
                key,
                rootNode,
                component.id
            );
            keysByDOMNode.set(rootNode, key);
        }

        morphComponent(component, vComponent);
    }

    function morphComponent(component, vComponent) {
        morphChildren(component.___rootNode, vComponent, component);
    }

    var detachedNodes = [];

    function detachNode(node, parentNode, ownerComponent) {
        if (node.nodeType === ELEMENT_NODE || node.nodeType === FRAGMENT_NODE) {
            detachedNodes.push(node);
            detachedByDOMNode.set(node, ownerComponent || true);
        } else {
            destroyNodeRecursive(node);
            removeChild(node);
        }
    }

    function destroyComponent(component) {
        component.destroy();
    }

    function morphChildren(fromNode, toNode, parentComponent) {
        var curFromNodeChild = firstChild(fromNode);
        var curToNodeChild = toNode.___firstChild;

        var curToNodeKey;
        var curFromNodeKey;
        var curToNodeType;

        var fromNextSibling;
        var toNextSibling;
        var matchingFromEl;
        var matchingFromComponent;
        var curVFromNodeChild;
        var fromComponent;

        outer: while (curToNodeChild) {
            toNextSibling = curToNodeChild.___nextSibling;
            curToNodeType = curToNodeChild.___nodeType;
            curToNodeKey = curToNodeChild.___key;

            // Skip <!doctype>
            if (
                curFromNodeChild &&
                curFromNodeChild.nodeType === DOCTYPE_NODE
            ) {
                curFromNodeChild = nextSibling(curFromNodeChild);
            }

            var ownerComponent =
                curToNodeChild.___ownerComponent || parentComponent;
            var referenceComponent;

            if (curToNodeType === COMPONENT_NODE) {
                var component = curToNodeChild.___component;
                if (
                    (matchingFromComponent =
                        existingComponentLookup[component.id]) === undefined
                ) {
                    if (isHydrate === true) {
                        var rootNode = beginFragmentNode(
                            curFromNodeChild,
                            fromNode
                        );
                        component.___rootNode = rootNode;
                        componentByDOMNode.set(rootNode, component);

                        if (ownerComponent && curToNodeKey) {
                            curToNodeKey = normalizeComponentKey(
                                curToNodeKey,
                                parentComponent.id
                            );
                            addComponentRootToKeyedElements(
                                ownerComponent.___keyedElements,
                                curToNodeKey,
                                rootNode,
                                component.id
                            );

                            keysByDOMNode.set(rootNode, curToNodeKey);
                        }

                        morphComponent(component, curToNodeChild);

                        curFromNodeChild = nextSibling(rootNode);
                    } else {
                        insertVirtualComponentBefore(
                            curToNodeChild,
                            curFromNodeChild,
                            fromNode,
                            component,
                            curToNodeKey,
                            ownerComponent,
                            parentComponent
                        );
                    }
                } else {
                    if (
                        matchingFromComponent.___rootNode !== curFromNodeChild
                    ) {
                        if (
                            curFromNodeChild &&
                            (fromComponent = componentByDOMNode.get(
                                curFromNodeChild
                            )) &&
                            globalComponentsContext.___renderedComponentsById[
                                fromComponent.id
                            ] === undefined
                        ) {
                            // The component associated with the current real DOM node was not rendered
                            // so we should just remove it out of the real DOM by destroying it
                            curFromNodeChild = nextSibling(
                                fromComponent.___rootNode
                            );
                            destroyComponent(fromComponent);
                            continue;
                        }

                        // We need to move the existing component into
                        // the correct location
                        insertBefore(
                            matchingFromComponent.___rootNode,
                            curFromNodeChild,
                            fromNode
                        );
                    } else {
                        curFromNodeChild =
                            curFromNodeChild && nextSibling(curFromNodeChild);
                    }

                    if (!curToNodeChild.___preserve) {
                        morphComponent(component, curToNodeChild);
                    }
                }

                curToNodeChild = toNextSibling;
                continue;
            } else if (curToNodeKey) {
                curVFromNodeChild = undefined;
                curFromNodeKey = undefined;
                var curToNodeKeyOriginal = curToNodeKey;

                if (isAutoKey(curToNodeKey)) {
                    if (ownerComponent !== parentComponent) {
                        curToNodeKey += ":" + ownerComponent.id;
                    }
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent = ownerComponent;
                }

                var keySequence =
                    keySequences[referenceComponent.id] ||
                    (keySequences[
                        referenceComponent.id
                    ] = globalComponentsContext.___createKeySequence());

                // We have a keyed element. This is the fast path for matching
                // up elements
                curToNodeKey = keySequence.___nextKey(curToNodeKey);

                if (curFromNodeChild) {
                    curFromNodeKey = keysByDOMNode.get(curFromNodeChild);
                    curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
                    fromNextSibling = nextSibling(curFromNodeChild);
                }

                if (curFromNodeKey === curToNodeKey) {
                    // Elements line up. Now we just have to make sure they are compatible
                    if (!curToNodeChild.___preserve) {
                        // We just skip over the fromNode if it is preserved

                        if (
                            compareNodeNames(curToNodeChild, curVFromNodeChild)
                        ) {
                            morphEl(
                                curFromNodeChild,
                                curVFromNodeChild,
                                curToNodeChild,
                                curToNodeKey,
                                ownerComponent,
                                parentComponent
                            );
                        } else {
                            // Remove the old node
                            detachNode(
                                curFromNodeChild,
                                fromNode,
                                ownerComponent
                            );

                            // Incompatible nodes. Just move the target VNode into the DOM at this position
                            insertVirtualNodeBefore(
                                curToNodeChild,
                                curToNodeKey,
                                curFromNodeChild,
                                fromNode,
                                ownerComponent,
                                parentComponent
                            );
                        }
                    }
                } else {
                    if (
                        (matchingFromEl =
                            referenceComponent.___keyedElements[
                                curToNodeKey
                            ]) === undefined
                    ) {
                        if (isHydrate === true && curFromNodeChild) {
                            if (
                                curFromNodeChild.nodeType === ELEMENT_NODE &&
                                caseInsensitiveCompare(
                                    curFromNodeChild.nodeName,
                                    curToNodeChild.___nodeName || ""
                                )
                            ) {
                                curVFromNodeChild = virtualizeElement(
                                    curFromNodeChild
                                );
                                curVFromNodeChild.___nodeName =
                                    curToNodeChild.___nodeName;
                                keysByDOMNode.set(
                                    curFromNodeChild,
                                    curToNodeKey
                                );
                                morphEl(
                                    curFromNodeChild,
                                    curVFromNodeChild,
                                    curToNodeChild,
                                    curToNodeKey,
                                    ownerComponent,
                                    parentComponent
                                );
                                curToNodeChild = toNextSibling;
                                curFromNodeChild = fromNextSibling;
                                continue;
                            } else if (
                                curToNodeChild.___nodeType === FRAGMENT_NODE &&
                                curFromNodeChild.nodeType === COMMENT_NODE
                            ) {
                                var content = curFromNodeChild.nodeValue;
                                if (content == "F#" + curToNodeKeyOriginal) {
                                    var endNode = curFromNodeChild.nextSibling;
                                    var depth = 0;
                                    var nodeValue;

                                    // eslint-disable-next-line no-constant-condition
                                    while (true) {
                                        if (endNode.nodeType === COMMENT_NODE) {
                                            nodeValue = endNode.nodeValue;
                                            if (nodeValue === "F/") {
                                                if (depth === 0) {
                                                    break;
                                                } else {
                                                    depth--;
                                                }
                                            } else if (
                                                nodeValue.indexOf("F#") === 0
                                            ) {
                                                depth++;
                                            }
                                        }
                                        endNode = endNode.nextSibling;
                                    }

                                    var fragment = createFragmentNode(
                                        curFromNodeChild,
                                        endNode.nextSibling,
                                        fromNode
                                    );
                                    keysByDOMNode.set(fragment, curToNodeKey);
                                    vElementByDOMNode.set(
                                        fragment,
                                        curToNodeChild
                                    );
                                    referenceComponent.___keyedElements[
                                        curToNodeKey
                                    ] = fragment;
                                    removeChild(curFromNodeChild);
                                    removeChild(endNode);

                                    if (!curToNodeChild.___preserve) {
                                        morphChildren(
                                            fragment,
                                            curToNodeChild,
                                            parentComponent
                                        );
                                    }

                                    curToNodeChild = toNextSibling;
                                    curFromNodeChild = fragment.nextSibling;
                                    continue;
                                }
                            }
                        }

                        insertVirtualNodeBefore(
                            curToNodeChild,
                            curToNodeKey,
                            curFromNodeChild,
                            fromNode,
                            ownerComponent,
                            parentComponent
                        );
                        fromNextSibling = curFromNodeChild;
                    } else {
                        if (
                            detachedByDOMNode.get(matchingFromEl) !== undefined
                        ) {
                            detachedByDOMNode.set(matchingFromEl, undefined);
                        }

                        if (!curToNodeChild.___preserve) {
                            curVFromNodeChild = vElementByDOMNode.get(
                                matchingFromEl
                            );

                            if (
                                compareNodeNames(
                                    curVFromNodeChild,
                                    curToNodeChild
                                )
                            ) {
                                if (fromNextSibling === matchingFromEl) {
                                    // Single element removal:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     D
                                    // D
                                    //
                                    // Single element swap:
                                    // A <-> A
                                    // B <-> C <-- We are here
                                    // C     B

                                    if (
                                        toNextSibling &&
                                        toNextSibling.___key === curFromNodeKey
                                    ) {
                                        // Single element swap

                                        // We want to stay on the current real DOM node
                                        fromNextSibling = curFromNodeChild;

                                        // But move the matching element into place
                                        insertBefore(
                                            matchingFromEl,
                                            curFromNodeChild,
                                            fromNode
                                        );
                                    } else {
                                        // Single element removal

                                        // We need to remove the current real DOM node
                                        // and the matching real DOM node will fall into
                                        // place. We will continue diffing with next sibling
                                        // after the real DOM node that just fell into place
                                        fromNextSibling = nextSibling(
                                            fromNextSibling
                                        );

                                        if (curFromNodeChild) {
                                            detachNode(
                                                curFromNodeChild,
                                                fromNode,
                                                ownerComponent
                                            );
                                        }
                                    }
                                } else {
                                    // A <-> A
                                    // B <-> D <-- We are here
                                    // C
                                    // D

                                    // We need to move the matching node into place
                                    insertAfter(
                                        matchingFromEl,
                                        curFromNodeChild,
                                        fromNode
                                    );

                                    if (curFromNodeChild) {
                                        detachNode(
                                            curFromNodeChild,
                                            fromNode,
                                            ownerComponent
                                        );
                                    }
                                }

                                morphEl(
                                    matchingFromEl,
                                    curVFromNodeChild,
                                    curToNodeChild,
                                    curToNodeKey,
                                    ownerComponent,
                                    parentComponent
                                );
                            } else {
                                insertVirtualNodeBefore(
                                    curToNodeChild,
                                    curToNodeKey,
                                    curFromNodeChild,
                                    fromNode,
                                    ownerComponent,
                                    parentComponent
                                );
                                detachNode(
                                    matchingFromEl,
                                    fromNode,
                                    ownerComponent
                                );
                            }
                        } else {
                            // preserve the node
                            // but still we need to diff the current from node
                            insertBefore(
                                matchingFromEl,
                                curFromNodeChild,
                                fromNode
                            );
                            fromNextSibling = curFromNodeChild;
                        }
                    }
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
                continue;
            }

            // The know the target node is not a VComponent node and we know
            // it is also not a preserve node. Let's now match up the HTML
            // element, text node, comment, etc.
            while (curFromNodeChild) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (
                    (fromComponent = componentByDOMNode.get(curFromNodeChild))
                ) {
                    // The current "to" element is not associated with a component,
                    // but the current "from" element is associated with a component

                    // Even if we destroy the current component in the original
                    // DOM or not, we still need to skip over it since it is
                    // not compatible with the current "to" node
                    curFromNodeChild = fromNextSibling;

                    if (
                        !globalComponentsContext.___renderedComponentsById[
                            fromComponent.id
                        ]
                    ) {
                        destroyComponent(fromComponent);
                    }

                    continue; // Move to the next "from" node
                }

                var curFromNodeType = curFromNodeChild.nodeType;

                var isCompatible = undefined;

                if (curFromNodeType === curToNodeType) {
                    if (curFromNodeType === ELEMENT_NODE) {
                        // Both nodes being compared are Element nodes
                        curVFromNodeChild = vElementByDOMNode.get(
                            curFromNodeChild
                        );
                        if (curVFromNodeChild === undefined) {
                            if (isHydrate === true) {
                                curVFromNodeChild = virtualizeElement(
                                    curFromNodeChild
                                );

                                if (
                                    caseInsensitiveCompare(
                                        curVFromNodeChild.___nodeName,
                                        curToNodeChild.___nodeName
                                    )
                                ) {
                                    curVFromNodeChild.___nodeName =
                                        curToNodeChild.___nodeName;
                                }
                            } else {
                                // Skip over nodes that don't look like ours...
                                curFromNodeChild = fromNextSibling;
                                continue;
                            }
                        } else if (
                            (curFromNodeKey = curVFromNodeChild.___key)
                        ) {
                            // We have a keyed element here but our target VDOM node
                            // is not keyed so this not doesn't belong
                            isCompatible = false;
                        }

                        isCompatible =
                            isCompatible !== false &&
                            compareNodeNames(
                                curVFromNodeChild,
                                curToNodeChild
                            ) === true;

                        if (isCompatible === true) {
                            // We found compatible DOM elements so transform
                            // the current "from" node to match the current
                            // target DOM node.
                            morphEl(
                                curFromNodeChild,
                                curVFromNodeChild,
                                curToNodeChild,
                                curToNodeKey,
                                ownerComponent,
                                parentComponent
                            );
                        }
                    } else if (
                        curFromNodeType === TEXT_NODE ||
                        curFromNodeType === COMMENT_NODE
                    ) {
                        // Both nodes being compared are Text or Comment nodes
                        isCompatible = true;
                        // Simply update nodeValue on the original node to
                        // change the text value
                        if (
                            curFromNodeChild.nodeValue !==
                            curToNodeChild.___nodeValue
                        ) {
                            curFromNodeChild.nodeValue =
                                curToNodeChild.___nodeValue;
                        }
                    }
                }

                if (isCompatible === true) {
                    // Advance both the "to" child and the "from" child since we found a match
                    curToNodeChild = toNextSibling;
                    curFromNodeChild = fromNextSibling;
                    continue outer;
                }

                detachNode(curFromNodeChild, fromNode, ownerComponent);
                curFromNodeChild = fromNextSibling;
            } // END: while (curFromNodeChild)

            // If we got this far then we did not find a candidate match for
            // our "to node" and we exhausted all of the children "from"
            // nodes. Therefore, we will just append the current "to" node
            // to the end
            insertVirtualNodeBefore(
                curToNodeChild,
                curToNodeKey,
                curFromNodeChild,
                fromNode,
                ownerComponent,
                parentComponent
            );

            curToNodeChild = toNextSibling;
            curFromNodeChild = fromNextSibling;
        }

        // We have processed all of the "to nodes".
        if (fromNode.___finishFragment) {
            // If we are in an unfinished fragment, we have reached the end of the nodes
            // we were matching up and need to end the fragment
            fromNode.___finishFragment(curFromNodeChild);
        } else {
            // If curFromNodeChild is non-null then we still have some from nodes
            // left over that need to be removed
            var fragmentBoundary =
                fromNode.nodeType === FRAGMENT_NODE ? fromNode.endNode : null;

            while (curFromNodeChild && curFromNodeChild !== fragmentBoundary) {
                fromNextSibling = nextSibling(curFromNodeChild);

                if (
                    (fromComponent = componentByDOMNode.get(curFromNodeChild))
                ) {
                    curFromNodeChild = fromNextSibling;
                    if (
                        !globalComponentsContext.___renderedComponentsById[
                            fromComponent.id
                        ]
                    ) {
                        destroyComponent(fromComponent);
                    }
                    continue;
                }

                curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);

                // For transcluded content, we need to check if the element belongs to a different component
                // context than the current component and ensure it gets removed from its key index.
                if (isAutoKey(keysByDOMNode.get(fromNode))) {
                    referenceComponent = parentComponent;
                } else {
                    referenceComponent =
                        curVFromNodeChild &&
                        curVFromNodeChild.___ownerComponent;
                }

                detachNode(curFromNodeChild, fromNode, referenceComponent);

                curFromNodeChild = fromNextSibling;
            }
        }
    }

    function morphEl(
        fromEl,
        vFromEl,
        toEl,
        toElKey,
        ownerComponent,
        parentComponent
    ) {
        var nodeName = toEl.___nodeName;

        if (isHydrate === true && toElKey) {
            var referenceComponent = isAutoKey(toElKey)
                ? parentComponent
                : ownerComponent;
            referenceComponent.___keyedElements[toElKey] = fromEl;
        }

        var constId = toEl.___constId;
        if (constId !== undefined && vFromEl.___constId === constId) {
            return;
        }

        morphAttrs(fromEl, vFromEl, toEl);

        if (nodeName !== "textarea") {
            morphChildren(fromEl, toEl, parentComponent);
        }

        var specialElHandler = specialElHandlers[nodeName];
        if (specialElHandler !== undefined) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    morphChildren(fromNode, toNode, toNode.___component);

    detachedNodes.forEach(function(node) {
        var detachedFromComponent = detachedByDOMNode.get(node);

        if (detachedFromComponent !== undefined) {
            detachedByDOMNode.set(node, undefined);

            var componentToDestroy = componentByDOMNode.get(node);
            if (componentToDestroy) {
                componentToDestroy.destroy();
            } else if (node.parentNode) {
                destroyNodeRecursive(
                    node,
                    detachedFromComponent !== true && detachedFromComponent
                );

                if (eventDelegation.___handleNodeDetach(node) != false) {
                    removeChild(node);
                }
            }
        }
    });
}

module.exports = morphdom;

});
$_mod.def("/marko$4.18.39/src/runtime/helpers/class-value", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function classHelper(arg) {
    var len,
        name,
        value,
        str = "";

    if (arg) {
        if (typeof arg === "string") {
            if (arg) {
                str += " " + arg;
            }
        } else if (typeof (len = arg.length) === "number") {
            for (var i = 0; i < len; i++) {
                value = classHelper(arg[i]);
                if (value) {
                    str += " " + value;
                }
            }
        } else if (typeof arg === "object") {
            for (name in arg) {
                value = arg[name];
                if (value) {
                    str += " " + name;
                }
            }
        }
    }

    return (str && str.slice(1)) || null;
};

});
$_mod.def("/marko$4.18.39/src/runtime/helpers/style-value", function(require, exports, module, __filename, __dirname) { "use strict";

var dashedNames = Object.create(null);

/**
 * Helper for generating the string for a style attribute
 */
module.exports = function styleHelper(style) {
    if (!style) {
        return null;
    }

    var type = typeof style;

    if (type !== "string") {
        var styles = "";

        if (Array.isArray(style)) {
            for (var i = 0, len = style.length; i < len; i++) {
                var next = styleHelper(style[i]);
                if (next)
                    styles += next + (next[next.length - 1] !== ";" ? ";" : "");
            }
        } else if (type === "object") {
            for (var name in style) {
                var value = style[name];
                if (value != null) {
                    if (typeof value === "number" && value) {
                        value += "px";
                    }

                    var nameDashed = dashedNames[name];
                    if (!nameDashed) {
                        nameDashed = dashedNames[name] = name
                            .replace(/([A-Z])/g, "-$1")
                            .toLowerCase();
                    }
                    styles += nameDashed + ":" + value + ";";
                }
            }
        }

        return styles || null;
    }

    return style;
};

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/helpers/attrs", function(require, exports, module, __filename, __dirname) { "use strict";

var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);
var classHelper = require('/marko$4.18.39/src/runtime/helpers/class-value'/*"../../helpers/class-value"*/);
var styleHelper = require('/marko$4.18.39/src/runtime/helpers/style-value'/*"../../helpers/style-value"*/);

/**
 * Helper for processing dynamic attributes
 */
module.exports = function(attributes) {
    if (typeof attributes === "string") {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                "Passing a string as a dynamic attribute value is deprecated - More details: https://github.com/marko-js/marko/wiki/Deprecation:-String-as-dynamic-attribute-value"
            );
        }
        return parseAttrs(attributes);
    }

    if (attributes && (attributes.style || attributes.class)) {
        var newAttributes = {};
        Object.keys(attributes).forEach(function(name) {
            if (name === "class") {
                newAttributes[name] = classHelper(attributes[name]);
            } else if (name === "style") {
                newAttributes[name] = styleHelper(attributes[name]);
            } else {
                newAttributes[name] = attributes[name];
            }
        });
        return newAttributes;
    }
    return attributes;
};

var parseContainer;
function parseAttrs(str) {
    if (str === "") {
        return {};
    }

    parseContainer = parseContainer || document.createElement("div");
    parseContainer.innerHTML = "<a " + str + ">";
    var attrs = parseContainer.firstChild.attributes;
    var result = {};
    var attr;

    for (var len = attrs.length, i = 0; i < len; i++) {
        attr = attrs[i];
        result[attr.name] = attr.value;
    }

    return result;
}

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/AsyncVDOMBuilder", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var vdom = require('/marko$4.18.39/src/runtime/vdom/vdom'/*"./vdom"*/);
var VElement = vdom.___VElement;
var VDocumentFragment = vdom.___VDocumentFragment;
var VComment = vdom.___VComment;
var VText = vdom.___VText;
var VComponent = vdom.___VComponent;
var VFragment = vdom.___VFragment;
var virtualizeHTML = vdom.___virtualizeHTML;
var RenderResult = require('/marko$4.18.39/src/runtime/RenderResult'/*"../RenderResult"*/);
var defaultDocument = vdom.___defaultDocument;
var morphdom = require('/marko$4.18.39/src/runtime/vdom/morphdom/index'/*"./morphdom"*/);
var attrsHelper = require('/marko$4.18.39/src/runtime/vdom/helpers/attrs'/*"./helpers/attrs"*/);

var EVENT_UPDATE = "update";
var EVENT_FINISH = "finish";

function State(tree) {
    this.___events = new EventEmitter();
    this.___tree = tree;
    this.___finished = false;
}

function AsyncVDOMBuilder(globalData, parentNode, parentOut) {
    if (!parentNode) {
        parentNode = new VDocumentFragment();
    }

    var state;

    if (parentOut) {
        state = parentOut.___state;
    } else {
        state = new State(parentNode);
    }

    this.___remaining = 1;
    this.___lastCount = 0;
    this.___last = null;
    this.___parentOut = parentOut;

    this.data = {};
    this.___state = state;
    this.___parent = parentNode;
    this.global = globalData || {};
    this.___stack = [parentNode];
    this.___sync = false;
    this.___vnode = undefined;
    this.___components = null;

    this.___assignedComponentDef = null;
    this.___assignedKey = null;
    this.___assignedCustomEvents = null;
}

var proto = (AsyncVDOMBuilder.prototype = {
    ___isOut: true,
    ___document: defaultDocument,

    bc: function(component, key, ownerComponent) {
        var vComponent = new VComponent(component, key, ownerComponent);
        return this.___beginNode(vComponent, 0, true);
    },

    ___preserveComponent: function(component, key, ownerComponent) {
        var vComponent = new VComponent(component, key, ownerComponent, true);
        this.___beginNode(vComponent, 0);
    },

    ___beginNode: function(child, childCount, pushToStack) {
        this.___parent.___appendChild(child);
        if (pushToStack === true) {
            this.___stack.push(child);
            this.___parent = child;
        }
        return childCount === 0 ? this : child;
    },

    element: function(
        tagName,
        attrs,
        key,
        component,
        childCount,
        flags,
        props
    ) {
        var element = new VElement(
            tagName,
            attrs,
            key,
            component,
            childCount,
            flags,
            props
        );
        return this.___beginNode(element, childCount);
    },

    ___elementDynamic: function(
        tagName,
        attrs,
        key,
        component,
        childCount,
        flags,
        props
    ) {
        return this.element(
            tagName,
            attrsHelper(attrs),
            key,
            component,
            childCount,
            flags,
            props
        );
    },

    n: function(node, component) {
        // NOTE: We do a shallow clone since we assume the node is being reused
        //       and a node can only have one parent node.
        var clone = node.___cloneNode();
        this.node(clone);
        clone.___ownerComponent = component;

        return this;
    },

    node: function(node) {
        this.___parent.___appendChild(node);
        return this;
    },

    text: function(text) {
        var type = typeof text;

        if (type != "string") {
            if (text == null) {
                return;
            } else if (type === "object") {
                if (text.toHTML) {
                    return this.h(text.toHTML());
                }
            }

            text = text.toString();
        }

        this.___parent.___appendChild(new VText(text));
        return this;
    },

    comment: function(comment) {
        return this.node(new VComment(comment));
    },

    html: function(html) {
        if (html != null) {
            var vdomNode = virtualizeHTML(html, this.___document || document);
            this.node(vdomNode);
        }

        return this;
    },

    beginElement: function(
        tagName,
        attrs,
        key,
        component,
        childCount,
        flags,
        props
    ) {
        var element = new VElement(
            tagName,
            attrs,
            key,
            component,
            childCount,
            flags,
            props
        );
        this.___beginNode(element, childCount, true);
        return this;
    },

    ___beginElementDynamic: function(
        tagName,
        attrs,
        key,
        component,
        childCount,
        flags,
        props
    ) {
        return this.beginElement(
            tagName,
            attrsHelper(attrs),
            key,
            component,
            childCount,
            flags,
            props
        );
    },

    ___beginFragment: function(key, component, preserve) {
        var fragment = new VFragment(key, component, preserve);
        this.___beginNode(fragment, null, true);
        return this;
    },

    ___endFragment: function() {
        this.endElement();
    },

    endElement: function() {
        var stack = this.___stack;
        stack.pop();
        this.___parent = stack[stack.length - 1];
    },

    end: function() {
        this.___parent = undefined;

        var remaining = --this.___remaining;
        var parentOut = this.___parentOut;

        if (remaining === 0) {
            if (parentOut) {
                parentOut.___handleChildDone();
            } else {
                this.___doFinish();
            }
        } else if (remaining - this.___lastCount === 0) {
            this.___emitLast();
        }

        return this;
    },

    ___handleChildDone: function() {
        var remaining = --this.___remaining;

        if (remaining === 0) {
            var parentOut = this.___parentOut;
            if (parentOut) {
                parentOut.___handleChildDone();
            } else {
                this.___doFinish();
            }
        } else if (remaining - this.___lastCount === 0) {
            this.___emitLast();
        }
    },

    ___doFinish: function() {
        var state = this.___state;
        state.___finished = true;
        state.___events.emit(EVENT_FINISH, this.___getResult());
    },

    ___emitLast: function() {
        var lastArray = this._last;

        var i = 0;

        function next() {
            if (i === lastArray.length) {
                return;
            }
            var lastCallback = lastArray[i++];
            lastCallback(next);

            if (!lastCallback.length) {
                next();
            }
        }

        next();
    },

    error: function(e) {
        try {
            this.emit("error", e);
        } finally {
            // If there is no listener for the error event then it will
            // throw a new Error here. In order to ensure that the async fragment
            // is still properly ended we need to put the end() in a `finally`
            // block
            this.end();
        }

        return this;
    },

    beginAsync: function(options) {
        if (this.___sync) {
            throw Error(
                "Tried to render async while in sync mode. Note: Client side await is not currently supported in re-renders (Issue: #942)."
            );
        }

        var state = this.___state;

        if (options) {
            if (options.last) {
                this.___lastCount++;
            }
        }

        this.___remaining++;

        var documentFragment = this.___parent.___appendDocumentFragment();
        var asyncOut = new AsyncVDOMBuilder(
            this.global,
            documentFragment,
            this
        );

        state.___events.emit("beginAsync", {
            out: asyncOut,
            parentOut: this
        });

        return asyncOut;
    },

    createOut: function() {
        return new AsyncVDOMBuilder(this.global);
    },

    flush: function() {
        var events = this.___state.___events;

        if (events.listenerCount(EVENT_UPDATE)) {
            events.emit(EVENT_UPDATE, new RenderResult(this));
        }
    },

    ___getOutput: function() {
        return this.___state.___tree;
    },

    ___getResult: function() {
        return this.___result || (this.___result = new RenderResult(this));
    },

    on: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && state.___finished) {
            callback(this.___getResult());
        } else if (event === "last") {
            this.onLast(callback);
        } else {
            state.___events.on(event, callback);
        }

        return this;
    },

    once: function(event, callback) {
        var state = this.___state;

        if (event === EVENT_FINISH && state.___finished) {
            callback(this.___getResult());
        } else if (event === "last") {
            this.onLast(callback);
        } else {
            state.___events.once(event, callback);
        }

        return this;
    },

    emit: function(type, arg) {
        var events = this.___state.___events;
        switch (arguments.length) {
            case 1:
                events.emit(type);
                break;
            case 2:
                events.emit(type, arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }
        return this;
    },

    removeListener: function() {
        var events = this.___state.___events;
        events.removeListener.apply(events, arguments);
        return this;
    },

    sync: function() {
        this.___sync = true;
    },

    isSync: function() {
        return this.___sync;
    },

    onLast: function(callback) {
        var lastArray = this._last;

        if (lastArray === undefined) {
            this._last = [callback];
        } else {
            lastArray.push(callback);
        }

        return this;
    },

    ___getNode: function(doc) {
        var node = this.___vnode;
        if (!node) {
            var vdomTree = this.___getOutput();
            // Create the root document fragment node
            doc = doc || this.___document || document;
            this.___vnode = node = vdomTree.___actualize(doc, null);
            morphdom(node, vdomTree, doc, this.___components);
        }
        return node;
    },

    toString: function(doc) {
        var docFragment = this.___getNode(doc);
        var html = "";

        var child = docFragment.firstChild;
        while (child) {
            var nextSibling = child.nextSibling;
            if (child.nodeType != 1) {
                var container = docFragment.ownerDocument.createElement("div");
                container.appendChild(child.cloneNode());
                html += container.innerHTML;
            } else {
                html += child.outerHTML;
            }

            child = nextSibling;
        }

        return html;
    },

    then: function(fn, fnErr) {
        var out = this;
        var promise = new Promise(function(resolve, reject) {
            out.on("error", reject).on(EVENT_FINISH, function(result) {
                resolve(result);
            });
        });

        return Promise.resolve(promise).then(fn, fnErr);
    },

    catch: function(fnErr) {
        return this.then(undefined, fnErr);
    },

    isVDOM: true,

    c: function(componentDef, key, customEvents) {
        this.___assignedComponentDef = componentDef;
        this.___assignedKey = key;
        this.___assignedCustomEvents = customEvents;
    }
});

proto.e = proto.element;
proto.be = proto.beginElement;
proto.ee = proto.___endElement = proto.endElement;
proto.t = proto.text;
proto.h = proto.w = proto.write = proto.html;

module.exports = AsyncVDOMBuilder;

});
$_mod.def("/marko$4.18.39/src/runtime/renderable", function(require, exports, module, __filename, __dirname) { var defaultCreateOut = require('/marko$4.18.39/src/runtime/createOut'/*"./createOut"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function safeRender(renderFunc, finalData, finalOut, shouldEnd) {
    try {
        renderFunc(finalData, finalOut);

        if (shouldEnd) {
            finalOut.end();
        }
    } catch (err) {
        var actualEnd = finalOut.end;
        finalOut.end = function() {};

        setTimeout(function() {
            finalOut.end = actualEnd;
            finalOut.error(err);
        }, 0);
    }
    return finalOut;
}

module.exports = function(target, renderer) {
    var renderFunc =
        renderer && (renderer.renderer || renderer.render || renderer);
    var createOut = target.createOut || renderer.createOut || defaultCreateOut;

    return extend(target, {
        createOut: createOut,

        renderToString: function(data, callback) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            if (callback) {
                out.on("finish", function() {
                    callback(null, out.toString(), out);
                }).once("error", callback);

                return safeRender(render, localData, out, true);
            } else {
                out.sync();
                render(localData, out);
                return out.toString();
            }
        },

        renderSync: function(data) {
            var localData = data || {};
            var render = renderFunc || this._;
            var globalData = localData.$global;
            var out = createOut(globalData);
            out.sync();

            out.global.template = this;

            if (globalData) {
                localData.$global = undefined;
            }

            render(localData, out);
            return out.___getResult();
        },

        /**
         * Renders a template to either a stream (if the last
         * argument is a Stream instance) or
         * provides the output to a callback function (if the last
         * argument is a Function).
         *
         * Supported signatures:
         *
         * render(data)
         * render(data, out)
         * render(data, stream)
         * render(data, callback)
         *
         * @param  {Object} data The view model data for the template
         * @param  {AsyncStream/AsyncVDOMBuilder} out A Stream, an AsyncStream/AsyncVDOMBuilder instance, or a callback function
         * @return {AsyncStream/AsyncVDOMBuilder} Returns the AsyncStream/AsyncVDOMBuilder instance that the template is rendered to
         */
        render: function(data, out) {
            var callback;
            var finalOut;
            var finalData;
            var globalData;
            var render = renderFunc || this._;
            var shouldBuffer = this.___shouldBuffer;
            var shouldEnd = true;

            if (data) {
                finalData = data;
                if ((globalData = data.$global)) {
                    finalData.$global = undefined;
                }
            } else {
                finalData = {};
            }

            if (out && out.___isOut) {
                finalOut = out;
                shouldEnd = false;
                extend(out.global, globalData);
            } else if (typeof out == "function") {
                finalOut = createOut(globalData);
                callback = out;
            } else {
                finalOut = createOut(
                    globalData, // global
                    out, // writer(AsyncStream) or parentNode(AsyncVDOMBuilder)
                    undefined, // parentOut
                    shouldBuffer // ignored by AsyncVDOMBuilder
                );
            }

            if (callback) {
                finalOut
                    .on("finish", function() {
                        callback(null, finalOut.___getResult());
                    })
                    .once("error", callback);
            }

            globalData = finalOut.global;

            globalData.template = globalData.template || this;

            return safeRender(render, finalData, finalOut, shouldEnd);
        }
    });
};

});
$_mod.def("/marko$4.18.39/src/runtime/vdom/index", function(require, exports, module, __filename, __dirname) { "use strict";
require('/marko$4.18.39/src/index-browser'/*"../../"*/);

// helpers provide a core set of various utility methods
// that are available in every template
var AsyncVDOMBuilder = require('/marko$4.18.39/src/runtime/vdom/AsyncVDOMBuilder'/*"./AsyncVDOMBuilder"*/);
var makeRenderable = require('/marko$4.18.39/src/runtime/renderable'/*"../renderable"*/);

/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.t = function createTemplate(path) {
    return new Template(path);
};

function Template(path, func) {
    this.path = path;
    this._ = func;
    this.meta = undefined;
}

function createOut(globalData, parent, parentOut) {
    return new AsyncVDOMBuilder(globalData, parent, parentOut);
}

var Template_prototype = (Template.prototype = {
    createOut: createOut
});

makeRenderable(Template_prototype);

exports.Template = Template;
exports.___createOut = createOut;

require('/marko$4.18.39/src/runtime/createOut'/*"../createOut"*/).___setCreateOut(createOut);

});
$_mod.def("/marko$4.18.39/src/vdom", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.18.39/src/runtime/vdom/index'/*"./runtime/vdom"*/);

});
$_mod.def("/marko$4.18.39/src/runtime/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function ensure(state, propertyName) {
    var proto = state.constructor.prototype;
    if (!(propertyName in proto)) {
        Object.defineProperty(proto, propertyName, {
            get: function() {
                return this.___raw[propertyName];
            },
            set: function(value) {
                this.___set(propertyName, value, false /* ensure:false */);
            }
        });
    }
}

function State(component) {
    this.___component = component;
    this.___raw = {};

    this.___dirty = false;
    this.___old = null;
    this.___changes = null;
    this.___forced = null; // An object that we use to keep tracking of state properties that were forced to be dirty

    Object.seal(this);
}

State.prototype = {
    ___reset: function() {
        var self = this;

        self.___dirty = false;
        self.___old = null;
        self.___changes = null;
        self.___forced = null;
    },

    ___replace: function(newState) {
        var state = this;
        var key;

        var rawState = this.___raw;

        for (key in rawState) {
            if (!(key in newState)) {
                state.___set(
                    key,
                    undefined,
                    false /* ensure:false */,
                    false /* forceDirty:false */
                );
            }
        }

        for (key in newState) {
            state.___set(
                key,
                newState[key],
                true /* ensure:true */,
                false /* forceDirty:false */
            );
        }
    },
    ___set: function(name, value, shouldEnsure, forceDirty) {
        var rawState = this.___raw;

        if (shouldEnsure) {
            ensure(this, name);
        }

        if (forceDirty) {
            var forcedDirtyState = this.___forced || (this.___forced = {});
            forcedDirtyState[name] = true;
        } else if (rawState[name] === value) {
            return;
        }

        if (!this.___dirty) {
            // This is the first time we are modifying the component state
            // so introduce some properties to do some tracking of
            // changes to the state
            this.___dirty = true; // Mark the component state as dirty (i.e. modified)
            this.___old = rawState;
            this.___raw = rawState = extend({}, rawState);
            this.___changes = {};
            this.___component.___queueUpdate();
        }

        this.___changes[name] = value;

        if (value === undefined) {
            // Don't store state properties with an undefined or null value
            delete rawState[name];
        } else {
            // Otherwise, store the new value in the component state
            rawState[name] = value;
        }
    },
    toJSON: function() {
        return this.___raw;
    }
};

module.exports = State;

});
$_mod.def("/marko$4.18.39/src/runtime/components/KeySequence", function(require, exports, module, __filename, __dirname) { function KeySequence() {
    this.___lookup = {};
}

KeySequence.prototype = {
    ___nextKey: function(key) {
        // var len = key.length;
        // var lastChar = key[len-1];
        // if (lastChar === ']') {
        //     key = key.substring(0, len-2);
        // }
        var lookup = this.___lookup;

        var currentIndex = lookup[key]++;
        if (!currentIndex) {
            lookup[key] = 1;
            currentIndex = 0;
            return key;
        } else {
            return key + "_" + currentIndex;
        }
    }
};

module.exports = KeySequence;

});
$_mod.def("/marko$4.18.39/src/runtime/components/GlobalComponentsContext", function(require, exports, module, __filename, __dirname) { var nextComponentIdProvider = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/).___nextComponentIdProvider;
var KeySequence = require('/marko$4.18.39/src/runtime/components/KeySequence'/*"./KeySequence"*/);

function GlobalComponentsContext(out) {
    this.___renderedComponentsById = {};
    this.___rerenderComponent = undefined;
    this.___nextComponentId = nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
    ___createKeySequence: function() {
        return new KeySequence();
    }
};

module.exports = GlobalComponentsContext;

});
$_mod.def("/marko$4.18.39/src/runtime/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { "use strict";
var GlobalComponentsContext = require('/marko$4.18.39/src/runtime/components/GlobalComponentsContext'/*"./GlobalComponentsContext"*/);

function ComponentsContext(out, parentComponentsContext) {
    var globalComponentsContext;
    var componentDef;

    if (parentComponentsContext) {
        globalComponentsContext = parentComponentsContext.___globalContext;
        componentDef = parentComponentsContext.___componentDef;

        var nestedContextsForParent;
        if (
            !(nestedContextsForParent =
                parentComponentsContext.___nestedContexts)
        ) {
            nestedContextsForParent = parentComponentsContext.___nestedContexts = [];
        }

        nestedContextsForParent.push(this);
    } else {
        globalComponentsContext = out.global.___components;
        if (globalComponentsContext === undefined) {
            out.global.___components = globalComponentsContext = new GlobalComponentsContext(
                out
            );
        }
    }

    this.___globalContext = globalComponentsContext;
    this.___components = [];
    this.___out = out;
    this.___componentDef = componentDef;
    this.___nestedContexts = undefined;
}

ComponentsContext.prototype = {
    ___initComponents: function(doc) {
        var componentDefs = this.___components;

        ComponentsContext.___initClientRendered(componentDefs, doc);

        this.___out.emit("___componentsInitialized");

        // Reset things stored in global since global is retained for
        // future renders
        this.___out.global.___components = undefined;

        return componentDefs;
    }
};

function getComponentsContext(out) {
    return (
        out.___components || (out.___components = new ComponentsContext(out))
    );
}

module.exports = exports = ComponentsContext;

exports.___getComponentsContext = getComponentsContext;

});
$_mod.installed("marko$4.18.39", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib\\listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.remap("/marko$4.18.39/src/runtime/nextTick", "/marko$4.18.39/src/runtime/nextTick-browser");
$_mod.def("/marko$4.18.39/src/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
    if (win.postMessage) {
        var queue = [];
        var messageName = "si";
        win.addEventListener(
            "message",
            function(event) {
                var source = event.source;
                if (source == win || (!source && event.data === messageName)) {
                    event.stopPropagation();
                    if (queue.length > 0) {
                        var fn = queue.shift();
                        fn();
                    }
                }
            },
            true
        );

        setImmediate = function(fn) {
            queue.push(fn);
            win.postMessage(messageName, "*");
        };
    } else {
        setImmediate = setTimeout;
    }
}

module.exports = setImmediate;

});
$_mod.def("/marko$4.18.39/src/runtime/components/update-manager", function(require, exports, module, __filename, __dirname) { "use strict";

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.18.39/src/runtime/nextTick-browser'/*"../nextTick"*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
    if (unbatchedQueue.length) {
        try {
            updateComponents(unbatchedQueue);
        } finally {
            // Reset the flag now that this scheduled batch update
            // is complete so that we can later schedule another
            // batched update if needed
            updatesScheduled = false;
        }
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
    // Loop over the components in the queue and update them.
    // NOTE: It is okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i = 0; i < queue.length; i++) {
        var component = queue[i];
        component.___update(); // Do the actual component update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var batch = {
        ___queue: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the components that where queued up
            // in this batch (if any)
            if (batch.___queue) {
                updateComponents(batch.___queue);
            }
        } finally {
            // Now that we have completed the update of all the components
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;
        }
    }
}

function queueComponentUpdate(component) {
    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the component on the top batch. When
        // the batch is ended this component will be updated.
        var batch = batchStack[batchStackLen - 1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.___queue) {
            batch.___queue.push(component);
        } else {
            batch.___queue = [component];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the component to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(component);
    }
}

exports.___queueComponentUpdate = queueComponentUpdate;
exports.___batchUpdate = batchUpdate;

});
$_mod.def("/marko$4.18.39/src/runtime/components/Component", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);

var domInsert = require('/marko$4.18.39/src/runtime/dom-insert'/*"../dom-insert"*/);
var defaultCreateOut = require('/marko$4.18.39/src/runtime/createOut'/*"../createOut"*/);
var getComponentsContext = require('/marko$4.18.39/src/runtime/components/ComponentsContext'/*"./ComponentsContext"*/)
    .___getComponentsContext;
var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;
var destroyNodeRecursive = componentsUtil.___destroyNodeRecursive;
var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var RenderResult = require('/marko$4.18.39/src/runtime/RenderResult'/*"../RenderResult"*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*"listener-tracker"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var updateManager = require('/marko$4.18.39/src/runtime/components/update-manager'/*"./update-manager"*/);
var morphdom = require('/marko$4.18.39/src/runtime/vdom/morphdom/index'/*"../vdom/morphdom"*/);
var eventDelegation = require('/marko$4.18.39/src/runtime/components/event-delegation'/*"./event-delegation"*/);
var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.___componentByDOMNode;
var CONTEXT_KEY = "__subtree_context__";

var slice = Array.prototype.slice;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};

var emit = EventEmitter.prototype.emit;
var ELEMENT_NODE = 1;

function removeListener(removeEventListenerHandle) {
    removeEventListenerHandle();
}

function walkFragments(fragment) {
    var node;

    while (fragment) {
        node = fragment.firstChild;

        if (!node) {
            break;
        }

        fragment = node.fragment;
    }

    return node;
}

function handleCustomEventWithMethodListener(
    component,
    targetMethodName,
    args,
    extraArgs
) {
    // Remove the "eventType" argument
    args.push(component);

    if (extraArgs) {
        args = extraArgs.concat(args);
    }

    var targetComponent = componentLookup[component.___scope];
    var targetMethod =
        typeof targetMethodName === "function"
            ? targetMethodName
            : targetComponent[targetMethodName];
    if (!targetMethod) {
        throw Error("Method not found: " + targetMethodName);
    }

    targetMethod.apply(targetComponent, args);
}

function resolveKeyHelper(key, index) {
    return index ? key + "_" + index : key;
}

function resolveComponentIdHelper(component, key, index) {
    return component.id + "-" + resolveKeyHelper(key, index);
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
    var handlerMethod;
    var handlers;

    for (var propName in stateChanges) {
        if (stateChanges.hasOwnProperty(propName)) {
            var handlerMethodName = "update_" + propName;

            handlerMethod = component[handlerMethodName];
            if (handlerMethod) {
                (handlers || (handlers = [])).push([propName, handlerMethod]);
            } else {
                // This state change does not have a state handler so return false
                // to force a rerender
                return;
            }
        }
    }

    // If we got here then all of the changed state properties have
    // an update handler or there are no state properties that actually
    // changed.
    if (handlers) {
        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        handlers.forEach(function(handler) {
            var propertyName = handler[0];
            handlerMethod = handler[1];

            var newValue = stateChanges[propertyName];
            var oldValue = oldState[propertyName];
            handlerMethod.call(component, newValue, oldValue);
        });

        emitLifecycleEvent(component, "update");

        component.___reset();
    }

    return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
    if (oldInput != newInput) {
        if (oldInput == null || newInput == null) {
            return true;
        }

        var oldKeys = Object.keys(oldInput);
        var newKeys = Object.keys(newInput);
        var len = oldKeys.length;
        if (len !== newKeys.length) {
            return true;
        }

        for (var i = 0; i < len; i++) {
            var key = oldKeys[i];
            if (oldInput[key] !== newInput[key]) {
                return true;
            }
        }
    }

    return false;
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
    EventEmitter.call(this);
    this.id = id;
    this.___state = null;
    this.___rootNode = null;
    this.___subscriptions = null;
    this.___domEventListenerHandles = null;
    this.___bubblingDomEvents = null; // Used to keep track of bubbling DOM events for components rendered on the server
    this.___customEvents = null;
    this.___scope = null;
    this.___renderInput = null;
    this.___input = undefined;
    this.___mounted = false;
    this.___global = undefined;

    this.___destroyed = false;
    this.___updateQueued = false;
    this.___dirty = false;
    this.___settingInput = false;

    this.___document = undefined;

    this.___keyedElements = {};
    this.___keySequence = undefined;
}

Component.prototype = componentProto = {
    ___isComponent: true,

    subscribeTo: function(target) {
        if (!target) {
            throw TypeError();
        }

        var subscriptions =
            this.___subscriptions ||
            (this.___subscriptions = new SubscriptionTracker());

        var subscribeToOptions = target.___isComponent
            ? COMPONENT_SUBSCRIBE_TO_OPTIONS
            : NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

        return subscriptions.subscribeTo(target, subscribeToOptions);
    },

    emit: function(eventType) {
        var customEvents = this.___customEvents;
        var target;

        if (customEvents && (target = customEvents[eventType])) {
            var targetMethodName = target[0];
            var isOnce = target[1];
            var extraArgs = target[2];
            var args = slice.call(arguments, 1);

            handleCustomEventWithMethodListener(
                this,
                targetMethodName,
                args,
                extraArgs
            );

            if (isOnce) {
                delete customEvents[eventType];
            }
        }

        if (this.listenerCount(eventType)) {
            return emit.apply(this, arguments);
        }
    },
    getElId: function(key, index) {
        if (!key) {
            return this.id;
        }
        return resolveComponentIdHelper(this, key, index);
    },
    getEl: function(key, index) {
        if (key) {
            var resolvedKey = resolveKeyHelper(key, index);
            var keyedElement = this.___keyedElements["@" + resolvedKey];

            if (!keyedElement) {
                var keyedComponent = this.getComponent(resolvedKey);

                if (keyedComponent) {
                    // eslint-disable-next-line no-constant-condition
                    if ("MARKO_DEBUG") {
                        complain(
                            "Accessing the elements of a child component using 'component.getEl' is deprecated."
                        );
                    }

                    return walkFragments(keyedComponent.___rootNode);
                }
            }

            return keyedElement;
        } else {
            return this.el;
        }
    },
    getEls: function(key) {
        key = key + "[]";

        var els = [];
        var i = 0;
        var el;
        while ((el = this.getEl(key, i))) {
            els.push(el);
            i++;
        }
        return els;
    },
    getComponent: function(key, index) {
        var rootNode = this.___keyedElements[resolveKeyHelper(key, index)];
        if (/\[\]$/.test(key)) {
            // eslint-disable-next-line no-constant-condition
            if ("MARKO_DEBUG") {
                complain(
                    "A repeated key[] was passed to getComponent. Use a non-repeating key if there is only one of these components."
                );
            }
            rootNode = rootNode && rootNode[Object.keys(rootNode)[0]];
        }
        return rootNode && componentsByDOMNode.get(rootNode);
    },
    getComponents: function(key) {
        var lookup = this.___keyedElements[key + "[]"];
        return lookup
            ? Object.keys(lookup)
                  .map(function(key) {
                      return componentsByDOMNode.get(lookup[key]);
                  })
                  .filter(Boolean)
            : [];
    },
    destroy: function() {
        if (this.___destroyed) {
            return;
        }

        var root = this.___rootNode;

        this.___destroyShallow();

        var nodes = root.nodes;

        nodes.forEach(function(node) {
            destroyNodeRecursive(node);

            if (eventDelegation.___handleNodeDetach(node) !== false) {
                node.parentNode.removeChild(node);
            }
        });

        root.detached = true;

        delete componentLookup[this.id];
        this.___keyedElements = {};
    },

    ___destroyShallow: function() {
        if (this.___destroyed) {
            return;
        }

        emitLifecycleEvent(this, "destroy");
        this.___destroyed = true;

        componentsByDOMNode.set(this.___rootNode, undefined);

        this.___rootNode = null;

        // Unsubscribe from all DOM events
        this.___removeDOMEventListeners();

        var subscriptions = this.___subscriptions;
        if (subscriptions) {
            subscriptions.removeAllListeners();
            this.___subscriptions = null;
        }
    },

    isDestroyed: function() {
        return this.___destroyed;
    },
    get state() {
        return this.___state;
    },
    set state(newState) {
        var state = this.___state;
        if (!state && !newState) {
            return;
        }

        if (!state) {
            state = this.___state = new this.___State(this);
        }

        state.___replace(newState || {});

        if (state.___dirty) {
            this.___queueUpdate();
        }

        if (!newState) {
            this.___state = null;
        }
    },
    setState: function(name, value) {
        var state = this.___state;

        if (!state) {
            state = this.___state = new this.___State(this);
        }
        if (typeof name == "object") {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    state.___set(k, newState[k], true /* ensure:true */);
                }
            }
        } else {
            state.___set(name, value, true /* ensure:true */);
        }
    },

    setStateDirty: function(name, value) {
        var state = this.___state;

        if (arguments.length == 1) {
            value = state[name];
        }

        state.___set(
            name,
            value,
            true /* ensure:true */,
            true /* forceDirty:true */
        );
    },

    replaceState: function(newState) {
        this.___state.___replace(newState);
    },

    get input() {
        return this.___input;
    },
    set input(newInput) {
        if (this.___settingInput) {
            this.___input = newInput;
        } else {
            this.___setInput(newInput);
        }
    },

    ___setInput: function(newInput, onInput, out) {
        onInput = onInput || this.onInput;
        var updatedInput;

        var oldInput = this.___input;
        this.___input = undefined;
        this.___context = (out && out[CONTEXT_KEY]) || this.___context;

        if (onInput) {
            // We need to set a flag to preview `this.input = foo` inside
            // onInput causing infinite recursion
            this.___settingInput = true;
            updatedInput = onInput.call(this, newInput || {}, out);
            this.___settingInput = false;
        }

        newInput = this.___renderInput = updatedInput || newInput;

        if ((this.___dirty = checkInputChanged(this, oldInput, newInput))) {
            this.___queueUpdate();
        }

        if (this.___input === undefined) {
            this.___input = newInput;
            if (newInput && newInput.$global) {
                this.___global = newInput.$global;
            }
        }

        return newInput;
    },

    forceUpdate: function() {
        this.___dirty = true;
        this.___queueUpdate();
    },

    ___queueUpdate: function() {
        if (!this.___updateQueued) {
            this.___updateQueued = true;
            updateManager.___queueComponentUpdate(this);
        }
    },

    update: function() {
        if (this.___destroyed === true || this.___isDirty === false) {
            return;
        }

        var input = this.___input;
        var state = this.___state;

        if (
            this.___dirty === false &&
            state !== null &&
            state.___dirty === true
        ) {
            if (
                processUpdateHandlers(
                    this,
                    state.___changes,
                    state.___old,
                    state
                )
            ) {
                state.___dirty = false;
            }
        }

        if (this.___isDirty === true) {
            // The UI component is still dirty after process state handlers
            // then we should rerender

            if (this.shouldUpdate(input, state) !== false) {
                this.___scheduleRerender();
            }
        }

        this.___reset();
    },

    get ___isDirty() {
        return (
            this.___dirty === true ||
            (this.___state !== null && this.___state.___dirty === true)
        );
    },

    ___reset: function() {
        this.___dirty = false;
        this.___updateQueued = false;
        this.___renderInput = null;
        var state = this.___state;
        if (state) {
            state.___reset();
        }
    },

    shouldUpdate: function() {
        return true;
    },

    ___emitLifecycleEvent: function(eventType, eventArg1, eventArg2) {
        emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
    },

    ___scheduleRerender: function() {
        var self = this;
        var renderer = self.___renderer;

        if (!renderer) {
            throw TypeError();
        }

        var input = this.___renderInput || this.___input;

        updateManager.___batchUpdate(function() {
            self.___rerender(input, false).afterInsert(self.___document);
        });

        this.___reset();
    },

    ___rerender: function(input, isHydrate) {
        var doc = this.___document;
        var globalData = this.___global;
        var rootNode = this.___rootNode;
        var renderer = this.___renderer;
        var createOut = renderer.createOut || defaultCreateOut;
        var out = createOut(globalData);
        out.sync();
        out.___document = this.___document;
        out[CONTEXT_KEY] = this.___context;

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.___globalContext;
        globalComponentsContext.___rerenderComponent = this;
        globalComponentsContext.___isHydrate = isHydrate;

        renderer(input, out);

        var result = new RenderResult(out);

        var targetNode = out.___getOutput().___firstChild;

        morphdom(rootNode, targetNode, doc, componentsContext);

        return result;
    },

    ___detach: function() {
        var root = this.___rootNode;
        root.remove();
        return root;
    },

    ___removeDOMEventListeners: function() {
        var eventListenerHandles = this.___domEventListenerHandles;
        if (eventListenerHandles) {
            eventListenerHandles.forEach(removeListener);
            this.___domEventListenerHandles = null;
        }
    },

    get ___rawState() {
        var state = this.___state;
        return state && state.___raw;
    },

    ___setCustomEvents: function(customEvents, scope) {
        var finalCustomEvents = (this.___customEvents = {});
        this.___scope = scope;

        customEvents.forEach(function(customEvent) {
            var eventType = customEvent[0];
            var targetMethodName = customEvent[1];
            var isOnce = customEvent[2];
            var extraArgs = customEvent[3];

            finalCustomEvents[eventType] = [
                targetMethodName,
                isOnce,
                extraArgs
            ];
        });
    },

    get el() {
        return walkFragments(this.___rootNode);
    },

    get els() {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                'The "this.els" attribute is deprecated. Please use "this.getEls(key)" instead.'
            );
        }
        return (this.___rootNode ? this.___rootNode.nodes : []).filter(function(
            el
        ) {
            return el.nodeType === ELEMENT_NODE;
        });
    }
};

componentProto.elId = componentProto.getElId;
componentProto.___update = componentProto.update;
componentProto.___destroy = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(
    componentProto,
    function getEl(component) {
        return component.___detach();
    },
    function afterInsert(component) {
        return component;
    }
);

inherit(Component, EventEmitter);

module.exports = Component;

});
$_mod.def("/marko$4.18.39/src/runtime/components/defineComponent", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var BaseState = require('/marko$4.18.39/src/runtime/components/State'/*"./State"*/);
var BaseComponent = require('/marko$4.18.39/src/runtime/components/Component'/*"./Component"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

module.exports = function defineComponent(def, renderer) {
    if (def.___isComponent) {
        return def;
    }

    var ComponentClass = function() {};
    var proto;

    var type = typeof def;

    if (type == "function") {
        proto = def.prototype;
    } else if (type == "object") {
        proto = def;
    } else {
        throw TypeError();
    }

    ComponentClass.prototype = proto;

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initComponent"
    // property and that method gets called later inside
    // init-components-browser.js
    function Component(id) {
        BaseComponent.call(this, id);
    }

    if (!proto.___isComponent) {
        // Inherit from Component if they didn't already
        inherit(ComponentClass, BaseComponent);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Component.prototype = ComponentClass.prototype;

    // proto.constructor = def.constructor = Component;

    // Set a flag on the constructor function to make it clear this is
    // a component so that we can short-circuit this work later
    Component.___isComponent = true;

    function State(component) {
        BaseState.call(this, component);
    }
    inherit(State, BaseState);
    proto.___State = State;
    proto.___renderer = renderer;

    return Component;
};

});
$_mod.main("/marko$4.18.39/src/runtime/components", "");
$_mod.remap("/marko$4.18.39/src/runtime/components/index", "/marko$4.18.39/src/runtime/components/index-browser");
$_mod.remap("/marko$4.18.39/src/runtime/components/init-components", "/marko$4.18.39/src/runtime/components/init-components-browser");
$_mod.installed("marko$4.18.39", "warp10", "2.0.1");
$_mod.def("/warp10$2.0.1/src/constants", function(require, exports, module, __filename, __dirname) { var win = typeof window !== "undefined" ? window : global;
exports.NOOP = win.$W10NOOP = win.$W10NOOP || function () {};
});
$_mod.def("/warp10$2.0.1/src/finalize", function(require, exports, module, __filename, __dirname) { var constants = require('/warp10$2.0.1/src/constants'/*"./constants"*/);
var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else if (info.type === 'NOOP') {
        return constants.NOOP;
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$2.0.1/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$2.0.1/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.18.39/src/runtime/components/ComponentDef", function(require, exports, module, __filename, __dirname) { "use strict";
var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);
var componentUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var attachBubblingEvent = componentUtil.___attachBubblingEvent;
var addDelegatedEventHandler = require('/marko$4.18.39/src/runtime/components/event-delegation'/*"./event-delegation"*/)
    .___addDelegatedEventHandler;
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var KeySequence = require('/marko$4.18.39/src/runtime/components/KeySequence'/*"./KeySequence"*/);

var FLAG_WILL_RERENDER_IN_BROWSER = 1;
// var FLAG_HAS_BODY_EL = 2;
// var FLAG_HAS_HEAD_EL = 4;
var FLAG_OLD_HYDRATE_NO_CREATE = 8;

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, globalComponentsContext) {
    this.___globalComponentsContext = globalComponentsContext; // The AsyncWriter that this component is associated with
    this.___component = component;
    this.id = componentId;

    this.___domEvents = undefined; // An array of DOM events that need to be added (in sets of three)

    this.___isExisting = false;

    this.___renderBoundary = false;
    this.___flags = 0;

    this.___nextIdIndex = 0; // The unique integer to use for the next scoped ID

    this.___keySequence = null;
}

ComponentDef.prototype = {
    ___nextKey: function(key) {
        var keySequence =
            this.___keySequence || (this.___keySequence = new KeySequence());
        return keySequence.___nextKey(key);
    },

    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current component.
     */
    elId: function(nestedId) {
        var id = this.id;

        if (nestedId == null) {
            return id;
        } else {
            if (typeof nestedId !== "string") {
                // eslint-disable-next-line no-constant-condition
                if ("MARKO_DEBUG") {
                    complain("Using non strings as keys is deprecated.");
                }

                nestedId = String(nestedId);
            }

            if (nestedId.indexOf("#") === 0) {
                id = "#" + id;
                nestedId = nestedId.substring(1);
            }

            return id + "-" + nestedId;
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
     */
    ___nextComponentId: function() {
        return this.id + "-c" + this.___nextIdIndex++;
    },

    d: function(eventName, handlerMethodName, isOnce, extraArgs) {
        addDelegatedEventHandler(eventName);
        return attachBubblingEvent(this, handlerMethodName, isOnce, extraArgs);
    },

    get ___type() {
        return this.___component.___type;
    }
};

ComponentDef.prototype.nk = ComponentDef.prototype.___nextKey;

ComponentDef.___deserialize = function(o, types, global, registry) {
    var id = o[0];
    var typeName = types[o[1]];
    var input = o[2];
    var extra = o[3];

    var isLegacy = extra.l;
    var state = extra.s;
    var componentProps = extra.w;
    var flags = extra.f;

    var component =
        typeName /* legacy */ &&
        registry.___createComponent(typeName, id, isLegacy);

    // Prevent newly created component from being queued for update since we area
    // just building it from the server info
    component.___updateQueued = true;

    if (
        !isLegacy &&
        flags & FLAG_WILL_RERENDER_IN_BROWSER &&
        !(flags & FLAG_OLD_HYDRATE_NO_CREATE)
    ) {
        if (component.onCreate) {
            component.onCreate(input, { global: global });
        }
        if (component.onInput) {
            input = component.onInput(input, { global: global }) || input;
        }
    } else {
        if (state) {
            var undefinedPropNames = extra.u;
            if (undefinedPropNames) {
                undefinedPropNames.forEach(function(undefinedPropName) {
                    state[undefinedPropName] = undefined;
                });
            }
            // We go through the setter here so that we convert the state object
            // to an instance of `State`
            component.state = state;
        }

        if (componentProps) {
            extend(component, componentProps);
        }
    }

    component.___input = input;

    if (extra.b) {
        component.___bubblingDomEvents = extra.b;
    }

    var scope = extra.p;
    var customEvents = extra.e;
    if (customEvents) {
        component.___setCustomEvents(customEvents, scope);
    }

    component.___global = global;

    return {
        id: id,
        ___component: component,
        ___boundary: extra.r,
        ___domEvents: extra.d,
        ___flags: extra.f || 0
    };
};

module.exports = ComponentDef;

});
$_mod.remap("/marko$4.18.39/src/runtime/components/registry", "/marko$4.18.39/src/runtime/components/registry-browser");
$_mod.def("/marko$4.18.39/src/runtime/components/init-components-browser", function(require, exports, module, __filename, __dirname) { "use strict";
var warp10Finalize = require('/warp10$2.0.1/finalize'/*"warp10/finalize"*/);
var eventDelegation = require('/marko$4.18.39/src/runtime/components/event-delegation'/*"./event-delegation"*/);
var win = window;
var defaultDocument = document;
var createFragmentNode = require('/marko$4.18.39/src/runtime/vdom/morphdom/fragment'/*"../vdom/morphdom/fragment"*/)
    .___createFragmentNode;
var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.___componentLookup;
var addComponentRootToKeyedElements =
    componentsUtil.___addComponentRootToKeyedElements;
var ComponentDef = require('/marko$4.18.39/src/runtime/components/ComponentDef'/*"./ComponentDef"*/);
var registry = require('/marko$4.18.39/src/runtime/components/registry-browser'/*"./registry"*/);
var domData = require('/marko$4.18.39/src/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.___componentByDOMNode;
var serverRenderedGlobals = {};
var serverComponentRootNodes = {};
var keyedElementsByComponentId = {};

var FLAG_WILL_RERENDER_IN_BROWSER = 1;

function indexServerComponentBoundaries(node, runtimeId, stack) {
    var componentId;
    var ownerId;
    var ownerComponent;
    var keyedElements;
    var nextSibling;
    var runtimeLength = runtimeId.length;
    stack = stack || [];

    node = node.firstChild;
    while (node) {
        nextSibling = node.nextSibling;
        if (node.nodeType === 8) {
            // Comment node
            var commentValue = node.nodeValue;
            if (commentValue.slice(0, runtimeLength) === runtimeId) {
                var firstChar = commentValue[runtimeLength];

                if (firstChar === "^" || firstChar === "#") {
                    stack.push(node);
                } else if (firstChar === "/") {
                    var endNode = node;
                    var startNode = stack.pop();
                    var rootNode;

                    if (startNode.parentNode === endNode.parentNode) {
                        rootNode = createFragmentNode(
                            startNode.nextSibling,
                            endNode
                        );
                    } else {
                        rootNode = createFragmentNode(
                            endNode.parentNode.firstChild,
                            endNode
                        );
                    }

                    componentId = startNode.nodeValue.substring(
                        runtimeLength + 1
                    );
                    firstChar = startNode.nodeValue[runtimeLength];

                    if (firstChar === "^") {
                        var parts = componentId.split(/ /g);
                        var key = parts[2];
                        ownerId = parts[1];
                        componentId = parts[0];
                        if ((ownerComponent = componentLookup[ownerId])) {
                            keyedElements = ownerComponent.___keyedElements;
                        } else {
                            keyedElements =
                                keyedElementsByComponentId[ownerId] ||
                                (keyedElementsByComponentId[ownerId] = {});
                        }
                        addComponentRootToKeyedElements(
                            keyedElements,
                            key,
                            rootNode,
                            componentId
                        );
                    }

                    serverComponentRootNodes[componentId] = rootNode;

                    startNode.parentNode.removeChild(startNode);
                    endNode.parentNode.removeChild(endNode);
                }
            }
        } else if (node.nodeType === 1) {
            // HTML element node
            var markoKey = node.getAttribute("data-marko-key");
            var markoProps = node.getAttribute("data-marko");
            if (markoKey) {
                var separatorIndex = markoKey.indexOf(" ");
                ownerId = markoKey.substring(separatorIndex + 1);
                markoKey = markoKey.substring(0, separatorIndex);
                if ((ownerComponent = componentLookup[ownerId])) {
                    keyedElements = ownerComponent.___keyedElements;
                } else {
                    keyedElements =
                        keyedElementsByComponentId[ownerId] ||
                        (keyedElementsByComponentId[ownerId] = {});
                }
                keyedElements[markoKey] = node;
            }
            if (markoProps) {
                markoProps = JSON.parse(markoProps);
                Object.keys(markoProps).forEach(function(key) {
                    if (key.slice(0, 2) === "on") {
                        eventDelegation.___addDelegatedEventHandler(
                            key.slice(2)
                        );
                    }
                });
            }
            indexServerComponentBoundaries(node, runtimeId, stack);
        }

        node = nextSibling;
    }
}

function invokeComponentEventHandler(component, targetMethodName, args) {
    var method = component[targetMethodName];
    if (!method) {
        throw Error("Method not found: " + targetMethodName);
    }

    method.apply(component, args);
}

function addEventListenerHelper(el, eventType, isOnce, listener) {
    var eventListener = listener;
    if (isOnce) {
        eventListener = function(event) {
            listener(event);
            el.removeEventListener(eventType, eventListener);
        };
    }

    el.addEventListener(eventType, eventListener, false);

    return function remove() {
        el.removeEventListener(eventType, eventListener);
    };
}

function addDOMEventListeners(
    component,
    el,
    eventType,
    targetMethodName,
    isOnce,
    extraArgs,
    handles
) {
    var removeListener = addEventListenerHelper(el, eventType, isOnce, function(
        event
    ) {
        var args = [event, el];
        if (extraArgs) {
            args = extraArgs.concat(args);
        }

        invokeComponentEventHandler(component, targetMethodName, args);
    });
    handles.push(removeListener);
}

function initComponent(componentDef, doc) {
    var component = componentDef.___component;

    if (!component || !component.___isComponent) {
        return; // legacy
    }

    component.___reset();
    component.___document = doc;

    var isExisting = componentDef.___isExisting;

    if (isExisting) {
        component.___removeDOMEventListeners();
    }

    var domEvents = componentDef.___domEvents;
    if (domEvents) {
        var eventListenerHandles = [];

        domEvents.forEach(function(domEventArgs) {
            // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

            var eventType = domEventArgs[0];
            var targetMethodName = domEventArgs[1];
            var eventEl = component.___keyedElements[domEventArgs[2]];
            var isOnce = domEventArgs[3];
            var extraArgs = domEventArgs[4];

            addDOMEventListeners(
                component,
                eventEl,
                eventType,
                targetMethodName,
                isOnce,
                extraArgs,
                eventListenerHandles
            );
        });

        if (eventListenerHandles.length) {
            component.___domEventListenerHandles = eventListenerHandles;
        }
    }

    if (component.___mounted) {
        component.___emitLifecycleEvent("update");
    } else {
        component.___mounted = true;
        component.___emitLifecycleEvent("mount");
    }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    eventDelegation.___init(doc);

    doc = doc || defaultDocument;
    var len = componentDefs.length;
    var componentDef;
    var i;

    for (i = len; i--; ) {
        componentDef = componentDefs[i];
        trackComponent(componentDef);
    }

    for (i = len; i--; ) {
        componentDef = componentDefs[i];
        initComponent(componentDef, doc);
    }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
    var type = typeof renderedComponents;
    var runtimeId;

    if (type !== "object") {
        var componentsKey =
            "$" +
            (type === "string"
                ? renderedComponents + "_components"
                : "components");
        renderedComponents = win[componentsKey];

        if (renderedComponents && renderedComponents.forEach) {
            renderedComponents.forEach(function(renderedComponent) {
                initServerRendered(renderedComponent, doc);
            });
        }

        win[componentsKey] = {
            concat: initServerRendered
        };

        return;
    }

    doc = doc || defaultDocument;

    renderedComponents = warp10Finalize(renderedComponents);

    runtimeId = renderedComponents.r;
    var componentDefs = renderedComponents.w;
    var typesArray = renderedComponents.t;
    var markoGlobalsKey = "$" + runtimeId + "G";

    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any components
    indexServerComponentBoundaries(doc, runtimeId);
    eventDelegation.___init(doc);

    var globals = win[markoGlobalsKey];
    if (globals) {
        serverRenderedGlobals = warp10Finalize(globals);
        delete win[markoGlobalsKey];
    }

    // hydrate components top down (leaf nodes last)
    // and return an array of functions to mount these components
    var deferredDefs;
    componentDefs
        .map(function(componentDef) {
            componentDef = ComponentDef.___deserialize(
                componentDef,
                typesArray,
                serverRenderedGlobals,
                registry
            );

            var mount = hydrateComponentAndGetMount(componentDef, doc);

            if (!mount) {
                // hydrateComponentAndGetMount will return false if there is not rootNode
                // for the component.  If this is the case, we'll wait until the
                // DOM has fully loaded to attempt to init the component again.
                if (deferredDefs) {
                    deferredDefs.push(componentDef);
                } else {
                    deferredDefs = [componentDef];
                    doc.addEventListener("DOMContentLoaded", function() {
                        indexServerComponentBoundaries(doc, runtimeId);
                        deferredDefs
                            .map(function(componentDef) {
                                return hydrateComponentAndGetMount(
                                    componentDef,
                                    doc
                                );
                            })
                            .reverse()
                            .forEach(tryInvoke);
                    });
                }
            }

            return mount;
        })
        .reverse()
        .forEach(tryInvoke);
}

function hydrateComponentAndGetMount(componentDef, doc) {
    var componentId = componentDef.id;
    var component = componentDef.___component;
    var rootNode = serverComponentRootNodes[componentId];
    var renderResult;

    if (rootNode) {
        delete serverComponentRootNodes[componentId];

        component.___rootNode = rootNode;
        componentsByDOMNode.set(rootNode, component);
        component.___keyedElements =
            keyedElementsByComponentId[componentId] || {};

        delete keyedElementsByComponentId[componentId];

        if (componentDef.___flags & FLAG_WILL_RERENDER_IN_BROWSER) {
            component.___document = doc;
            renderResult = component.___rerender(component.___input, true);
            trackComponent(componentDef);
            return function mount() {
                renderResult.afterInsert(doc);
            };
        } else {
            trackComponent(componentDef);
        }

        return function mount() {
            initComponent(componentDef, doc);
        };
    }
}

function trackComponent(componentDef) {
    var component = componentDef.___component;
    if (component) {
        componentLookup[component.id] = component;
    }
}

function tryInvoke(fn) {
    if (fn) fn();
}

exports.___initClientRendered = initClientRendered;
exports.___initServerRendered = initServerRendered;

});
$_mod.def("/marko$4.18.39/src/runtime/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var initComponents = require('/marko$4.18.39/src/runtime/components/init-components-browser'/*"./init-components"*/);
var registry = require('/marko$4.18.39/src/runtime/components/registry-browser'/*"./registry"*/);

require('/marko$4.18.39/src/runtime/components/ComponentsContext'/*"./ComponentsContext"*/).___initClientRendered =
    initComponents.___initClientRendered;

exports.getComponentForEl = componentsUtil.___getComponentForEl;
exports.init = window.$initComponents = initComponents.___initServerRendered;

exports.register = function(id, component) {
    registry.r(id, function() {
        return component;
    });
};

});
$_mod.def("/marko$4.18.39/src/runtime/components/registry-browser", function(require, exports, module, __filename, __dirname) { var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);
var defineComponent = require('/marko$4.18.39/src/runtime/components/defineComponent'/*"./defineComponent"*/);
var loader = require('/marko$4.18.39/src/loader/index-browser'/*"../../loader"*/);
require('/marko$4.18.39/src/runtime/components/index-browser'/*"."*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(componentId, def) {
    registered[componentId] = def;
    delete loaded[componentId];
    delete componentTypes[componentId];
    return componentId;
}

function load(typeName, isLegacy) {
    var target = loaded[typeName];
    if (!target) {
        target = registered[typeName];

        if (target) {
            target = target();
        } else if (isLegacy) {
            target = window.$markoLegacy.load(typeName);
        } else {
            target = loader(typeName);
            // eslint-disable-next-line no-constant-condition
            if ("MARKO_DEBUG") {
                complain(
                    "Looks like you used `require:` in your browser.json to load a component.  This requires that Marko has knowledge of how lasso generates paths and will be removed in a future version.  `marko-dependencies:/path/to/template.marko` should be used instead."
                );
            }
        }

        if (!target) {
            throw Error("Component not found: " + typeName);
        }

        loaded[typeName] = target;
    }

    return target;
}

function getComponentClass(typeName, isLegacy) {
    var ComponentClass = componentTypes[typeName];

    if (ComponentClass) {
        return ComponentClass;
    }

    ComponentClass = load(typeName, isLegacy);

    ComponentClass = ComponentClass.Component || ComponentClass;

    if (!ComponentClass.___isComponent) {
        ComponentClass = defineComponent(
            ComponentClass,
            ComponentClass.renderer
        );
    }

    // Make the component "type" accessible on each component instance
    ComponentClass.prototype.___type = typeName;

    // eslint-disable-next-line no-constant-condition
    if ("MARKO_DEBUG") {
        var classNameMatch = /\/([^/]+?)(?:\/index|\/template|)(?:\.marko|\.component(?:-browser)?|)$/.exec(
            typeName
        );
        var className = classNameMatch
            ? classNameMatch[1]
            : "AnonymousComponent";
        className = className.replace(/-(.)/g, function(g) {
            return g[1].toUpperCase();
        });
        className = className
            .replace(/\$\d+\.\d+\.\d+$/, "")
            .replace(/^[^a-z$_]/i, "_$&")
            .replace(/[^0-9a-z$_]+/gi, "_");
        className = className[0].toUpperCase() + className.slice(1);
        // eslint-disable-next-line no-unused-vars
        try {
            var OldComponentClass = ComponentClass;
            eval(
                "ComponentClass = function " +
                    className +
                    "(id, doc) { OldComponentClass.call(this, id, doc); }"
            );
            ComponentClass.prototype = OldComponentClass.prototype;
        } catch (e) {
            /** ignore error */
        }
    }

    componentTypes[typeName] = ComponentClass;

    return ComponentClass;
}

function createComponent(typeName, id, isLegacy) {
    var ComponentClass = getComponentClass(typeName, isLegacy);
    return new ComponentClass(id);
}

exports.r = register;
exports.___createComponent = createComponent;

});
$_mod.remap("/marko$4.18.39/src/runtime/components/beginComponent", "/marko$4.18.39/src/runtime/components/beginComponent-browser");
$_mod.def("/marko$4.18.39/src/runtime/components/beginComponent-browser", function(require, exports, module, __filename, __dirname) { var ComponentDef = require('/marko$4.18.39/src/runtime/components/ComponentDef'/*"./ComponentDef"*/);

module.exports = function beginComponent(
    componentsContext,
    component,
    key,
    ownerComponentDef
) {
    var componentId = component.id;

    var globalContext = componentsContext.___globalContext;
    var componentDef = (componentsContext.___componentDef = new ComponentDef(
        component,
        componentId,
        globalContext
    ));
    globalContext.___renderedComponentsById[componentId] = true;
    componentsContext.___components.push(componentDef);

    var out = componentsContext.___out;
    out.bc(component, key, ownerComponentDef && ownerComponentDef.___component);
    return componentDef;
};

});
$_mod.remap("/marko$4.18.39/src/runtime/components/endComponent", "/marko$4.18.39/src/runtime/components/endComponent-browser");
$_mod.def("/marko$4.18.39/src/runtime/components/endComponent-browser", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function endComponent(out) {
    out.ee(); // endElement() (also works for VComponent nodes pushed on to the stack)
};

});
$_mod.def("/marko$4.18.39/src/runtime/components/renderer", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.18.39/src/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.___componentLookup;
var emitLifecycleEvent = componentsUtil.___emitLifecycleEvent;

var ComponentsContext = require('/marko$4.18.39/src/runtime/components/ComponentsContext'/*"./ComponentsContext"*/);
var getComponentsContext = ComponentsContext.___getComponentsContext;
var registry = require('/marko$4.18.39/src/runtime/components/registry-browser'/*"./registry"*/);
var copyProps = require('/raptor-util$3.2.0/copyProps'/*"raptor-util/copyProps"*/);
var isServer = componentsUtil.___isServer === true;
var beginComponent = require('/marko$4.18.39/src/runtime/components/beginComponent-browser'/*"./beginComponent"*/);
var endComponent = require('/marko$4.18.39/src/runtime/components/endComponent-browser'/*"./endComponent"*/);

var COMPONENT_BEGIN_ASYNC_ADDED_KEY = "$wa";

function resolveComponentKey(key, parentComponentDef) {
    if (key[0] === "#") {
        return key.substring(1);
    } else {
        return parentComponentDef.id + "-" + parentComponentDef.___nextKey(key);
    }
}

function trackAsyncComponents(out) {
    if (out.isSync() || out.global[COMPONENT_BEGIN_ASYNC_ADDED_KEY]) {
        return;
    }

    out.on("beginAsync", handleBeginAsync);
    out.on("beginDetachedAsync", handleBeginDetachedAsync);
    out.global[COMPONENT_BEGIN_ASYNC_ADDED_KEY] = true;
}

function handleBeginAsync(event) {
    var parentOut = event.parentOut;
    var asyncOut = event.out;
    var componentsContext = parentOut.___components;

    if (componentsContext !== undefined) {
        // We are going to start a nested ComponentsContext
        asyncOut.___components = new ComponentsContext(
            asyncOut,
            componentsContext
        );
    }
    // Carry along the component arguments
    asyncOut.c(
        parentOut.___assignedComponentDef,
        parentOut.___assignedKey,
        parentOut.___assignedCustomEvents
    );
}

function handleBeginDetachedAsync(event) {
    var asyncOut = event.out;
    handleBeginAsync(event);
    asyncOut.on("beginAsync", handleBeginAsync);
    asyncOut.on("beginDetachedAsync", handleBeginDetachedAsync);
}

function createRendererFunc(
    templateRenderFunc,
    componentProps,
    renderingLogic
) {
    renderingLogic = renderingLogic || {};
    var onInput = renderingLogic.onInput;
    var typeName = componentProps.___type;
    var isSplit = componentProps.___split === true;
    var isImplicitComponent = componentProps.___implicit === true;

    var shouldApplySplitMixins = isSplit;

    return function renderer(input, out) {
        trackAsyncComponents(out);

        var componentsContext = getComponentsContext(out);
        var globalComponentsContext = componentsContext.___globalContext;

        var component = globalComponentsContext.___rerenderComponent;
        var isRerender = component !== undefined;
        var id;
        var isExisting;
        var customEvents;
        var parentComponentDef = componentsContext.___componentDef;
        var ownerComponentDef = out.___assignedComponentDef;
        var ownerComponentId = ownerComponentDef && ownerComponentDef.id;
        var key = out.___assignedKey;

        if (component) {
            // If component is provided then we are currently rendering
            // the top-level UI component as part of a re-render
            id = component.id; // We will use the ID of the component being re-rendered
            isExisting = true; // This is a re-render so we know the component is already in the DOM
            globalComponentsContext.___rerenderComponent = null;
        } else {
            // Otherwise, we are rendering a nested UI component. We will need
            // to match up the UI component with the component already in the
            // DOM (if any) so we will need to resolve the component ID from
            // the assigned key. We also need to handle any custom event bindings
            // that were provided.
            if (parentComponentDef) {
                // console.log('componentArgs:', componentArgs);
                customEvents = out.___assignedCustomEvents;

                if (key != null) {
                    id = resolveComponentKey(
                        key.toString(),
                        parentComponentDef
                    );
                } else {
                    id = parentComponentDef.___nextComponentId();
                }
            } else {
                id = globalComponentsContext.___nextComponentId();
            }
        }

        if (isServer) {
            // If we are rendering on the server then things are simplier since
            // we don't need to match up the UI component with a previously
            // rendered component already mounted to the DOM. We also create
            // a lightweight ServerComponent
            component = registry.___createComponent(
                renderingLogic,
                id,
                input,
                out,
                typeName,
                customEvents,
                ownerComponentId
            );

            // This is the final input after running the lifecycle methods.
            // We will be passing the input to the template for the `input` param
            input = component.___updatedInput;

            component.___updatedInput = undefined; // We don't want ___updatedInput to be serialized to the browser
        } else {
            if (!component) {
                if (
                    isRerender &&
                    (component = componentLookup[id]) &&
                    component.___type !== typeName
                ) {
                    // Destroy the existing component since
                    component.destroy();
                    component = undefined;
                }

                if (component) {
                    isExisting = true;
                } else {
                    isExisting = false;
                    // We need to create a new instance of the component
                    component = registry.___createComponent(typeName, id);

                    if (shouldApplySplitMixins === true) {
                        shouldApplySplitMixins = false;

                        var renderingLogicProps =
                            typeof renderingLogic == "function"
                                ? renderingLogic.prototype
                                : renderingLogic;

                        copyProps(
                            renderingLogicProps,
                            component.constructor.prototype
                        );
                    }
                }

                // Set this flag to prevent the component from being queued for update
                // based on the new input. The component is about to be rerendered
                // so we don't want to queue it up as a result of calling `setInput()`
                component.___updateQueued = true;

                if (customEvents !== undefined) {
                    component.___setCustomEvents(
                        customEvents,
                        ownerComponentId
                    );
                }

                if (isExisting === false) {
                    emitLifecycleEvent(component, "create", input, out);
                }

                input = component.___setInput(input, onInput, out);

                if (isExisting === true) {
                    if (
                        component.___isDirty === false ||
                        component.shouldUpdate(input, component.___state) ===
                            false
                    ) {
                        // We put a placeholder element in the output stream to ensure that the existing
                        // DOM node is matched up correctly when using morphdom. We flag the VElement
                        // node to track that it is a preserve marker
                        out.___preserveComponent(component);
                        globalComponentsContext.___renderedComponentsById[
                            id
                        ] = true;
                        component.___reset(); // The component is no longer dirty so reset internal flags
                        return;
                    }
                }
            }

            component.___global = out.global;

            emitLifecycleEvent(component, "render", out);
        }

        var componentDef = beginComponent(
            componentsContext,
            component,
            key,
            ownerComponentDef,
            isSplit,
            isImplicitComponent
        );

        componentDef.___isExisting = isExisting;

        // Render the template associated with the component using the final template
        // data that we constructed
        templateRenderFunc(
            input,
            out,
            componentDef,
            component,
            component.___rawState
        );

        endComponent(out, componentDef);
        componentsContext.___componentDef = parentComponentDef;
    };
}

module.exports = createRendererFunc;

// exports used by the legacy renderer
createRendererFunc.___resolveComponentKey = resolveComponentKey;
createRendererFunc.___trackAsyncComponents = trackAsyncComponents;

});
$_mod.def("/marko$4.18.39/src/runtime/helpers/for-of", function(require, exports, module, __filename, __dirname) { "use strict";

var complain = "MARKO_DEBUG" && require('/complain$1.6.0/index'/*"complain"*/);

/**
 * Internal helper method to handle <for of> loops.
 */
module.exports = function forOf(array, callback) {
    var i;

    if (array == null) {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                "Passing a non iterable to a <for> loop is deprecated. Prefer to use an <if> around the loop instead."
            );
        }
    } else if (Array.isArray(array)) {
        for (i = 0; i < array.length; i++) {
            callback(array[i], i, array);
        }
        // eslint-disable-next-line no-constant-condition
    } else if (typeof array.forEach === "function") {
        array.forEach(callback);
    } else if (typeof array.next === "function") {
        i = 0;
        do {
            var result = array.next();
            callback(result.value, i++, array);
        } while (!result.done);
    } else if (typeof array == "function") {
        // eslint-disable-next-line no-constant-condition
        if ("MARKO_DEBUG") {
            complain(
                "Passing a function as the iterable in a <for> loop is deprecated and will be removed in a future version of Marko"
            );
        }
        // Also allow the first argument to be a custom iterator function
        array(callback);
    }
};

});
$_mod.def("/undefined$0/components/button-counter/button-counter.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.18.39/src/vdom'/*"marko/src/vdom"*/).t(),
    marko_component = {
        onCreate: function() {
          this.state = {
              count: 0
            };
        },
        increment: function() {
          this.state.count++;
        }
      },
    components_registry_browser = require('/marko$4.18.39/src/runtime/components/registry-browser'/*"marko/src/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/undefined$0/components/button-counter/button-counter.marko", function() {
      return module.exports;
    }),
    marko_renderer = require('/marko$4.18.39/src/runtime/components/renderer'/*"marko/src/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.18.39/src/runtime/components/defineComponent'/*"marko/src/runtime/components/defineComponent"*/),
    marko_attrs0 = {
        "class": "count"
      },
    marko_attrs1 = {
        "class": "example-button"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.e("div", marko_attrs0, "0", component, 1)
    .t(state.count);

  out.e("button", marko_attrs1, "1", component, 1, 0, {
      onclick: __component.d("click", "increment", false)
    })
    .t("lick me!");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/marko$4.18.39/src/runtime/helpers/load-tag", function(require, exports, module, __filename, __dirname) { "use strict";

/**
 * Helper to load a custom tag
 */
module.exports = function loadTagHelper(renderer) {
    if (renderer) {
        renderer = resolveRenderer(renderer);
    }

    return function wrappedRenderer(
        input,
        out,
        componentDef,
        key,
        customEvents
    ) {
        out.c(componentDef, key, customEvents);
        renderer(input, out);
        out.___assignedComponentDef = null;
    };
};

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function(input, out) {
        var rendererFunc = handler.renderer || handler._ || handler.render;
        if (typeof rendererFunc !== "function") {
            throw Error("Invalid renderer");
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer || handler._;

    if (renderer) {
        return renderer;
    }

    if (typeof handler === "function") {
        return handler;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

});
$_mod.def("/undefined$0/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.18.39 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.18.39/src/vdom'/*"marko/src/vdom"*/).t(),
    marko_component = {
        onCreate: function() {
          this.state = {
              now: (new Date()).toString()
            };
        }
      },
    components_registry_browser = require('/marko$4.18.39/src/runtime/components/registry-browser'/*"marko/src/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/undefined$0/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = require('/marko$4.18.39/src/runtime/components/renderer'/*"marko/src/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.18.39/src/runtime/components/defineComponent'/*"marko/src/runtime/components/defineComponent"*/),
    marko_forOf = require('/marko$4.18.39/src/runtime/helpers/for-of'/*"marko/src/runtime/helpers/for-of"*/),
    button_counter_template = require('/undefined$0/components/button-counter/button-counter.marko'/*"./components/button-counter/button-counter.marko"*/),
    marko_loadTag = require('/marko$4.18.39/src/runtime/helpers/load-tag'/*"marko/src/runtime/helpers/load-tag"*/),
    button_counter_tag = marko_loadTag(button_counter_template),
    marko_attrs0 = {
        "class": "colors"
      };

function render(input, out, __component, component, state) {
  var data = input;

  const name = "Seth 2";

  const colors = ["red", "green", "blue"];

  out.e("h1", null, "0", component, 4)
    .t("Hello ")
    .t(name)
    .t(" ")
    .t(state.now);

  out.be("ul", marko_attrs0, "1", component);

  var $for$0 = 0;

  marko_forOf(colors, function(color) {
    var $keyScope$0 = "[" + (($for$0++) + "]");

    out.e("li", null, "2" + $keyScope$0, component, 1)
      .t(color);
  });

  out.ee();

  button_counter_tag({}, out, __component, "3");
}

marko_template._ = marko_renderer(render, {
    ___type: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/undefined$0/client", function(require, exports, module, __filename, __dirname) { var helloComponent = require('/undefined$0/index.marko'/*"./index"*/);

helloComponent.renderSync({ name: "Marko" }).appendTo(document.body);

});
$_mod.run("/undefined$0/client");