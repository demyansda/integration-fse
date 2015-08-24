'use strict';

var rpm = require('integration-common/api-wrappers');
var rpmUtil = require('integration-common/util');
var util = require('util');
var promised = require('promised-io/promise');

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
            for (var srcField in fieldMap) {
                result[fieldMap[srcField]] = formValues[srcField];
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
                console.log('No updatable fields for', route.src.Process, '->', route.dst.Process);
                return;
            }

            var stat = new rpmUtil.ChangeStatistics(route.src.Process + '->' + route.dst.Process);

            var srcForms = data[0];
            var dstForms = data[1];

            var linkedField = route.src._linkedFormIdField;

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
                var dstForm = dstForms[dstId];
                if (dstForm) {
                    steps.push(function () {
                        return route.editForm(dstForm, fieldMap);
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

Route.prototype.getFieldMappings = function () {
    var pair = this;
    var dstProc = pair.dst;
    var srcProc = pair.src;

    var linkedFormIdFieldName = srcProc._linkedFormIdField || LINKED_FORM_ID_FIELD;

    return promised.seq([
        function () {
            return promised.all(srcProc.getFields(true), dstProc.getFields(true));
        },
        function (responses) {
            var srcFields = responses[0].Fields;
            var dstFields = responses[1].Fields;

            var linkedFormIdField = srcFields[linkedFormIdFieldName];
            if (!linkedFormIdField) {
                console.error(util.format('Linked form field "%s" not found in the process "%s"', linkedFormIdFieldName, srcProc.Process));
                return null;
            }

            var fieldMappings = {};

            function processFields(srcFieldName, dstFieldName) {
                if (dstFieldName == linkedFormIdFieldName) {
                    return;
                }
                var dst = dstFields[dstFieldName];
                var src = srcFields[srcFieldName];
                if (!(dst && isFieldSupported(src) && isFieldSupported(dst))) {
                    return;
                }
                if (dst.SubType !== src.SubType) {
                    console.warn(util.format('Incompatible data types.\nSource: [%s][%s], Destination: [%s][%s]',
                        srcProc.Process, srcFieldName, dstProc.Process, dstFieldName));
                    return;
                }
                fieldMappings[dstFieldName] = srcFieldName;
            }

            for (var fieldName in srcFields) {
                processFields(fieldName, fieldName);
            }
            var efm = pair.extraFieldMappings;
            if (efm) {
                for (var dstFieldName in efm) {
                    processFields(efm[dstFieldName], dstFieldName);
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
        patch[route.dst._linkedFormIdField || LINKED_FORM_ID_FIELD] = srcId;
        return route.dst.addForm(patch);
    });
    steps.push(function (newForm) {
        var dstId = newForm.Form.FormID;
        var patch = {};
        patch[route.src._linkedFormIdField || LINKED_FORM_ID_FIELD] = dstId;
        return promised.all(
            route.src._api.editForm(srcForm.FormID, patch),
            srcForm.Archived && route.dst._api.setFormArchived(true, dstId)
            );
    });
    return promised.seq(steps);
};

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
        var dstId = srcForm.getFieldValue(route.src._linkedFormIdField || LINKED_FORM_ID_FIELD);
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

var LINKED_FORM_ID_FIELD = exports.LINKED_FORM_ID_FIELD = 'linkedFormId';

var KNOWN_FIELD_TYPES = [rpm.OBJECT_TYPE.CustomField];

function isFieldSupported(field) {
    return field.UserCanEdit && !field.IsRepeating && KNOWN_FIELD_TYPES.indexOf(field.FieldType) >= 0;
}

exports.Route = Route;

