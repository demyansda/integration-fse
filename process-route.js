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
                    var src = srcFields[srcFieldName];
                    if (!isFieldSupported(src)) {
                        console.error(ERROR_FIELD_NOT_SUPPORTED, srcProc.Process, src);
                        continue;
                    }
                    if (!isFieldSupported(dst)) {
                        console.error(ERROR_FIELD_NOT_SUPPORTED, dstProc.Process, dst);
                        continue;
                    }
                    var subType = src.SubType;
                    if (dst.SubType !== subType) {
                        console.warn(util.format('Incompatible data types.\nSource: [%s][%s], Destination: [%s][%s]',
                            srcProc.Process, srcFieldName, dstProc.Process, dstFieldName));
                        continue;
                    }
                    if(subType===rpm.DATA_TYPE.FieldTableDefinedRow) {
                        isTableDescriptionsMatch(src,dst);
                    }
                    fieldMappings[dstFieldName] = srcFieldName;
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
var ERROR_FIELD_NOT_SUPPORTED = 'Field not supported'

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

var KNOWN_FIELD_TYPES = [rpm.OBJECT_TYPE.CustomField];

function isFieldSupported(field) {
    return field && field.UserCanEdit && !field.IsRepeating && KNOWN_FIELD_TYPES.indexOf(field.FieldType) >= 0;
}

exports.Route = Route;



/*
    FieldTableDefinedRow: 46,

=== Field: Orders { Name: 'TABF1',
  Uid: '500_26545',
  Order: 4,
  IsRepeating: false,
  FieldType: 500,
  SubType: 46,
  FormatType: 18,
  LayoutFormat: { Width: '1' },
  InternalFormat: { TotalsRow: 0 },
  UserCanEdit: true,
  IsRequiredForUser: false,
  Archived: false,
  Rows: 
   [ { ID: 9697,
       Name: '',
       Order: 0,
       IsDefinition: true,
       IsLabelRow: false,
       IsShown: true,
       Fields: [Object] },
     { ID: 9698,
       Name: 'Xxx',
       Order: 1,
       IsDefinition: false,
       IsLabelRow: false,
       IsShown: true,
       Fields: [Object] } ] }
*/


function isTableDescriptionsMatch(rows1, rows2) {
    console.log('isTableDescriptionsMatch');
    rows1 = rows1.Rows || rows1;
    rows2 = rows2.Rows || rows2;
    if (rows1.length !== rows2.length) {
        return false;
    }
    
    function xxx(rows) {
        var definitionRow;
        var dataRows = {};
        rows.forEach(function(row) {
            if(row.IsLabelRow){
                return;
            }
            
            if(row.IsDefinition) {
                definitionRow = definitionRow || row;
            } else {
                dataRows[row.Name] = row;
            }
        }
            
        console.log (row); 
        });
         
    }
       console.log ('tab1');
    rows1.forEach(function(row) {
       console.log (row); 
    });
       console.log ('tab2');
    rows2.forEach(function(row) {
       console.log (row); 
    });
    
    return false;
    
}

/*

    FieldTable: 45,
    
Table with variable number of rows
=== Field: Orders { Name: 'FFF2', 
  Uid: '500_26552',
  Order: 10,
  IsRepeating: false,
  FieldType: 500,
  SubType: 45,
  FormatType: 18,
  LayoutFormat: { Width: '1' },
  InternalFormat: { TotalsRow: 0 },
  UserCanEdit: true,
  IsRequiredForUser: false,
  Archived: false,
  Rows: 
   [ { ID: 9703,
       Name: '',
       Order: 0,
       IsDefinition: true,
       IsLabelRow: false,
       IsShown: true,
       Fields: [Object] } ] }
=== Row: { ID: 9703,
  Name: '',
  Order: 0,
  IsDefinition: true,
  IsLabelRow: false,
  IsShown: true,
  Fields: 
   [ { Name: 'Q',
       Uid: '500_26553',
       Order: 1,
       IsRepeating: false,
       FieldType: 500,
       SubType: 14,
       FormatType: 20,
       LayoutFormat: [Object],
       UserCanEdit: true,
       IsRequiredForUser: false,
       Archived: false },
     { Name: 'T',
       Uid: '500_26554',
       Order: 2,
       IsRepeating: false,
       FieldType: 500,
       SubType: 1,
       FormatType: 7,
       LayoutFormat: [Object],
       UserCanEdit: true,
       IsRequiredForUser: false,
       Archived: false } ] }
       */