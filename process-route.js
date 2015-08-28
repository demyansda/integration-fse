'use strict';

var rpm = require('integration-common/api-wrappers');
var rpmUtil = require('integration-common/util');
var util = require('util');
var promised = require('promised-io/promise');
var fm = require('./field-match');

function Route(srcProc, dstProc, extraFieldMappings) {
    this.src = srcProc;
    this.dst = dstProc;
    this.extraFieldMappings = extraFieldMappings;
}

Route.prototype.getPatch = function (srcForm, fieldMap) {
    var route = this;
    return promised.seq([
        function () {
            return fieldMap || route.getFieldMappings();
        },
        function (fieldMap) {
            var result = {};
            var formValues = srcForm.getFieldsAsObject();
            for (var dstField in fieldMap) {
                result[dstField] = formValues[fieldMap[dstField]];
            }
            return result;
        }
    ]);
}

Route.prototype.sync = function () {
    var route = this;

    return promised.seq([
        function () {
            return route.getFieldMappings();
        },
        function (fieldMap) {
            if (!rpmUtil.isEmpty(fieldMap)) {
                return promised.all(route.src.getFormsData(), route.dst.getFormsData(), fieldMap);
            }
        },
        function (data) {
            if (!data) {
                console.warn('No updatable fields for', route.src.Process, '->', route.dst.Process);
                return;
            }

            var stat = new rpmUtil.ChangeStatistics(route.src.Process + '->' + route.dst.Process);

            var srcForms = data[0];
            var dstForms = data[1];

            var linkedField = getLinkedFormIdField(route.src);

            var steps = [];

            var dstJustUpdated = route.dst.getCache().justUpdatedForms = {};
            var srcJustUpdated = route.src.getCache().justUpdatedForms;

            var fieldMap = data[2];

            function addSteps(srcId) {
                if (srcJustUpdated && srcJustUpdated[srcId]) {
                    return;
                }
                var srcForm = srcForms[srcId];
                var dstId = srcForm.getFieldValue(linkedField);
                if (dstForms[dstId]) {
                    steps.push(function () {
                        return route.editForm(srcForm, fieldMap);
                    });
                    steps.push(function () {
                        stat.incUpdated();
                    });
                } else {
                    steps.push(function () {
                        return route.addForm(srcForm, fieldMap);
                    });
                    steps.push(function () {
                        stat.incAdded();
                    });
                }
                steps.push(function () {
                    dstJustUpdated[dstId] = true;
                });
            }

            for (var key in srcForms) {
                addSteps(key);
            }
            steps.push(function () {
                console.log('Changes:', stat);
            });

            return promised.seq(steps);
        }
    ]);
}

var ERROR_LINKED_FIELD_ABSENT = 'Linked form field "%s" not found in the process "%s"';

function getLinkedFormIdField(process) {
    return process._linkedFormIdField || LINKED_FORM_ID_FIELD;
}


function getAndValidateFields(proc) {
    return promised.seq([
        function () {
            return proc.getFields(true);
        },
        function (fields) {
            fields = fields.Fields;
            var linkedIdFieldName = getLinkedFormIdField(proc);
            var srcLinkedIdFld = fields[linkedIdFieldName];
            if (!srcLinkedIdFld) {
                console.error(util.format(ERROR_LINKED_FIELD_ABSENT, linkedIdFieldName, proc.Process));
                return;
            }
            delete fields[linkedIdFieldName];
            return fields;
        }
    ]);
}

Route.prototype.getFieldMappings = function () {
    var route = this;
    var dstProc = route.dst;
    var srcProc = route.src;

    return promised.seq([
        function () {
            return promised.all(getAndValidateFields(srcProc), getAndValidateFields(dstProc));
        },
        function (responses) {

            var fieldMappings = {};
            var srcFields = responses[0];
            var dstFields = responses[1];

            if (srcFields && dstFields) {
                var efm = route.extraFieldMappings || {};
                for (var srcFieldName in srcFields) {
                    var dstFieldName = efm[srcFieldName] || srcFieldName;
                    var dst = dstFields[dstFieldName];
                    if (!dst) {
                        continue;
                    }
                    try {
                        fm.matchProcessFields(srcFields[srcFieldName], dst);
                        fieldMappings[dstFieldName] = srcFieldName;
                    } catch (error) {
                        if(error instanceof Error) {
                            throw error;
                        }
                        console.warn(error);
                    } 
                }
            }
            return fieldMappings;
        }
    ]);
}


Route.prototype.addForm = function (srcId, fieldMap) {
    var route = this;
    var steps = [];
    var srcForm;
    steps.push(function () {
        return typeof srcId === 'object' ? srcId : route.src._api.getForm(srcId);
    });
    steps.push(function (result) {
        srcForm = result.Form || result;
        return route.getPatch(srcForm, fieldMap);
    });
    steps.push(function (patch) {
        if (rpmUtil.isEmpty(patch)) {
            return rpmUtil.getRejectedPromise(ERROR_NO_DATA);
        }
        patch[getLinkedFormIdField(route.dst)] = srcForm.FormID;
        return route.dst.addForm(patch);
    });
    steps.push(function (newForm) {
        var dstId = newForm.Form.FormID;
        var patch = {};
        patch[getLinkedFormIdField(route.src)] = dstId;
        return promised.all(
            route.src._api.editForm(srcForm.FormID, patch),
            srcForm.Archived && route.dst._api.setFormArchived(true, dstId)
            );
    });
    return promised.seq(steps);
};

var ERROR_NO_DATA = 'No data to send'
var ERROR_FIELD_NOT_FOUND = 'Field not found'

Route.prototype.editForm = function (srcId, fieldMap) {

    var route = this;
    var steps = [];
    var srcForm;
    steps.push(function () {
        return typeof srcId === 'object' ? srcId : route.src._api.getForm(srcId);
    });
    steps.push(function (result) {
        srcForm = result.Form || result;
        return route.getPatch(srcForm, fieldMap);
    });
    steps.push(function (patch) {
        if (rpmUtil.isEmpty(patch)) {
            return rpmUtil.getRejectedPromise(ERROR_NO_DATA);
        }
        var dstId = srcForm.getFieldValue(getLinkedFormIdField(route.src));
        return route.dst._api.editForm(dstId, patch);
    });
    steps.push(function (dstForm) {
        dstForm = dstForm.Form;
        if (srcForm.Archived != dstForm.Archived) {
            return route.dst._api.setFormArchived(srcForm.Archived, dstForm.FormID);
        }
    });
    return promised.seq(steps);
};

var LINKED_FORM_ID_FIELD = 'linkedFormId';


exports.Route = Route;

