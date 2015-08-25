'use strict';

var rpm = require('integration-common/api-wrappers');
var rpmUtil = require('integration-common/util');
var util = require('util');
var promised = require('promised-io/promise');
var Deferred = promised.Deferred;
var webhooks = require('integration-web/webhooks');
var prt = require('./process-route');

var config = rpmUtil.readConfig('RPM_CONFIG', 'config.json');

function updateSubscriptionInfo() {
    var api = this;
    return promised.seq([
        function () {
            return api.getInfo();
        },
        function (info) {
            api.instance = info.RPM;
            api.subscriber = info.Subscriber;
        }
    ]);
}


function initRoutes() {

    var apis = {};

    return promised.seq([
        function () {
            var promises = [];
            for (var key in config.subscriptions) {
                var api = new rpm.RpmApi(config.subscriptions[key]);
                var existingKey = api.url + api.key;
                var existingApi = apis[existingKey];
                if (existingApi) {
                    api = existingApi;
                } else {
                    apis[existingKey] = api;
                    api.updateSubscriptionInfo = updateSubscriptionInfo;
                    api.procCache = {};
                    promises.push(promised.seq([
                        function () {
                            return api.getProcesses(true);
                        },
                        function (response) {
                            response.forEach(function (proc) {
                                proc.getFormsData = getFormsData;
                                proc.getCache = rpmUtil.getCache;
                                proc.deleteCache = rpmUtil.deleteCache;
                                api.procCache[proc.Process] = proc;
                            });
                        }
                    ]));
                }
                config.subscriptions[key] = api;
            };
            return promised.all(promises);
        },
        function () {
            var routes = [];

            var allProcesses = [];

            function getProcess(procDef) {
                var api = rpmUtil.getEager(config.subscriptions, procDef.subscription, 'Unknown subscription: ');
                var result = rpmUtil.getEager(api.procCache, procDef.process, 'Unknown Process: ');
                if (!rpmUtil.pushIfNotIn(allProcesses, result)) {
                    throw new Error('Duplicate process:', result);
                }
                result._linkedFormIdField = procDef.linkedFormIdField;
                return result;
            }

            function validateFieldMappings(object) {
                var values = [];
                for (var key in object) {
                    var value = object[key];
                    if (typeof value !== 'string') {
                        throw new Error('Bad field name:', value);
                    }
                    if (values.indexOf(value) >= 0) {
                        throw new Error('Duplicate destination fields:', object);
                    }
                    values.push(value);
                }
                return true;
            }


            config.dataFlow.forEach(function (procPair) {
                try {
                    var extraFieldMappings = procPair.extraFieldMappings || {};
                    validateFieldMappings(extraFieldMappings);

                    var srcProc = getProcess(procPair.src);
                    var dstProc = getProcess(procPair.dst);

                    routes.push(new prt.Route(srcProc, dstProc, extraFieldMappings));

                    if (procPair.twoWay) {
                        var reverseFieldMappings = {};
                        for (var key in extraFieldMappings) {
                            reverseFieldMappings[extraFieldMappings[key]] = key;
                        }
                        routes.push(new prt.Route(dstProc, srcProc, reverseFieldMappings));
                    }
                } catch (error) {
                    console.error(error);
                    return;
                }
            });

            for (var key in apis) {
                delete apis[key].procCache;
            }
            routes.getRoutingTree = getRoutingTree;
            routes.getApis = getApis;
            routes.sync = syncAllRoutes;
            console.log('Routes:', routes);
            return routes;
        }
    ]);
}

function getApis() {
    var routes = this;
    var apis = [];
    routes.forEach(function (pair) {
        rpmUtil.pushIfNotIn(apis, pair.src._api);
        rpmUtil.pushIfNotIn(apis, pair.dst._api);
    });
    return apis;
}

function getRoutingTree() {
    var routes = this;
    return promised.seq([
        function () {
            return promised.all(routes.getApis().map(function (api) {
                return api.updateSubscriptionInfo();
            }));
        },
        function () {
            var tree = {};
            routes.forEach(function (pair) {
                var srcProc = pair.src;
                var subscription = rpmUtil.getOrCreate(rpmUtil.getOrCreate(tree, srcProc._api.instance, {}), srcProc._api.subscriber, {});
                subscription[srcProc.ProcessID] = pair;
            });
            return tree;
        }
    ]);
}

function getFormsData() {
    var proc = this;
    var cache = proc.getCache();
    return cache.formsData || promised.seq([
        function () {
            return proc.getFormList(true);
        },
        function (formList) {
            var steps = [];
            var result = {};
            formList.forEach(function (formInfo) {
                var formId = formInfo.ID;
                steps.push(function () {
                    return proc._api.getForm(formId);
                });
                steps.push(function (form) {
                    form = form.Form;
                    result[formId] = form;
                });
            });
            steps.push(function () {
                cache.formsData = result;
                return result;
            })
            return promised.seq(steps);
        }
    ]);
}




var routes;
var tree;

function syncAllRoutes() {
    var routes = this;
    var steps = [];
    routes.forEach(function (route) {
        steps.push(function () {
            return route.sync();
        });
    });
    steps.push(function () {
        routes.forEach(function (route) {
            route.src.deleteCache();
            route.dst.deleteCache();
        });
    });
    return promised.seq(steps);
}

promised.seq([
    function () {
        return initRoutes();
    },
    function (result) {
        routes = result;
        return result.length ? promised.all(routes.sync(), routes.getRoutingTree()) : rpmUtil.getRejectedPromise('There is no routes');
    },
    function (results) {
        tree = results[1];
        console.log(tree);
        startWebHooksServer();
    }
]).then(
    function () {
    },
    function (error) {
        console.error(error);
    }
    );




function startWebHooksServer() {


    var processing;
    var queue = [];

    function process() {
        if (processing) {
            return;
        }

        processing = true;
        var treeUpdated = false;


        function getRoute(obj) {
            var keys = [obj.Instance, obj.Subscriber, obj.ParentID]
            return rpmUtil.getDeepValue(tree, keys) ||
                (treeUpdated ? undefined : promised.seq([
                    function () {
                        return routes.getRoutingTree();
                    },
                    function (newTree) {
                        tree = newTree;
                        treeUpdated = true;
                        return rpmUtil.getDeepValue(tree, keys)
                    }
                ]));
        }

        var steps = [];

        function addStep(obj) {
            steps.push(function () {
                return getRoute(obj);
            });
            steps.push(function (route) {
                if (!route) {
                    return new Error('Route cannot be found for ' + JSON.stringify(obj));
                }
                var deferred = new Deferred();
                (obj.EventName === webhooks.EVENT_FORM_START ? route.addForm(obj.ObjectID) : route.editForm(obj.ObjectID)).then(
                    function (result) {
                        deferred.resolve(result);
                    },
                    function (error) {
                        deferred.resolve(error instanceof Error ? error : new Error(error));
                    }
                    );
                return deferred.promise;
            });
            steps.push(function (result) {
                if (result instanceof Error) {
                    console.error(result);
                }
            });
        }

        while (queue.length) {
            addStep(queue.shift());
        }

        processing = false;
        return promised.seq(steps);

    }


    return webhooks.start(config.webHooks.port, config.webHooks.path, function (obj) {
        console.log('Webhooks request: ', obj);

        var error;
        if (obj.ObjectType !== rpm.OBJECT_TYPE.Form) {
            error = 'Unsupported ObjectType';
        } else if (obj.ParentType !== rpm.OBJECT_TYPE.PMTemplate) {
            error = 'Unsupported ParentType';
        } else if (obj.EventName !== webhooks.EVENT_FORM_START && obj.EventName !== webhooks.EVENT_FORM_EDIT) {
            error = 'Unsupported EventName';
        }

        if (error) {
            console.error(error, obj);
            return;
        }

        queue.push(obj);
        process();
    });

}

