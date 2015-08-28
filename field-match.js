'use strict';
var rpm = require('integration-common/api-wrappers');
var rpmUtil = require('integration-common/util');
var util = require('util');

var KNOWN_FIELD_TYPES = [rpm.OBJECT_TYPE.CustomField];
var ERROR_FIELD_NOT_SUPPORTED = 'Field not supported'
var ERROR_INCOMPATIBLE_TYPES = 'Incompatible data types'


function isFieldSupported(field) {
    return field && field.UserCanEdit && !field.IsRepeating && KNOWN_FIELD_TYPES.indexOf(field.FieldType) >= 0;
}


function matchProcessFields(src, dst) {
    [src, dst].forEach(function (field) {
        if (!isFieldSupported(field)) {
            throw util.format('Process field Uid=%s not supported', field.Uid);

        }
    });
    var subType = src.SubType;
    if (dst.SubType !== subType) {
        throw (util.format('%s. Fields: [Uid=%s, Uid=%s]', ERROR_INCOMPATIBLE_TYPES, src.Uid, dst.Uid));
    }
    if (subType === rpm.DATA_TYPE.FieldTableDefinedRow) {
        matchFields(src, dst);
    }
}


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

function getTableRows(processField) {
    var rows = processField;
    var result = { dataRows: {} };
    rows.forEach(function (row) {
        if (row.IsLabelRow) {
            return;
        }
        var fields = {};
        row.Fields.forEach(function (tableField) {
            if (!isFieldSupported(tableField)) {
                throw util.format('%s. Process field: "%s", Row: %d, Table field: "%s"', ERROR_FIELD_NOT_SUPPORTED, processField.Uid, row.ID, tableField.Name);
            }
            fields[tableField.Name] = tableField;
        });
        if (row.IsDefinition) {
            result.definitionRow = result.definitionRow || fields;
        } else {
            result.dataRows[row.Name] = fields;
        }
    });
    return result;
};

function dummy () {}

function matchObjects(obj1, obj2, matcher) {
    var names = {};

    matcher = matcher || dummy;

    for (var key in obj1) {
        matcher(rpmUtil.getEager(obj2, key), obj1.dataRows[key]);
        names[key] = true;
    }

    for (var key in obj2) {
        if (!names[key]) {
            matcher(rpmUtil.getEager(obj1, key), obj2.dataRows[key]);
        }
    }
}

function matchFields(field1, field2) {
    console.log('isTableDescriptionsMatch');

    var rows1 = getTableRows(field1);
    var rows2 = getTableRows(field2);

    function matchTableFields(tableField1, tablefield2) {
        if (tableField1.SubType !== tablefield2.SubType) {
            throw util.format('%s. Table Fields: [%s, %s]', ERROR_INCOMPATIBLE_TYPES, tableField1, tablefield2);
        }
    }

    function matchRows(row1, row2) {
        matchObjects(row1, row2, matchTableFields);
    }

    matchRows(rows1.definitionRow, rows2.definitionRow);
    matchObjects(rows1.dataRows, rows2.dataRows, matchRows);
    matchObjects(rows2.dataRows, rows1.dataRows, matchRows);

}

function getOptions(field) {
    var options = {};
    field.Options.forEach(function (option) {
        if (!option.IsLabel) {
            options[option.Text] = true;
        }
    });
    return options;
}

function matchOptions(field1, field2) {
    console.log('isTableDescriptionsMatch');

    var opts1 = getOptions(field1);
    var opts2 = getOptions(field2);

    matchObjects(opts1.dataRows, opts2.dataRows);

}


/*

  Options: 
   [ { Text: '1', ID: 31708, IsHidden: false, IsLabel: false },
     { Text: '2', ID: 31709, IsHidden: false, IsLabel: false },
     { Text: '3', ID: 31710, IsHidden: false, IsLabel: false } ],


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

exports.matchProcessFields = matchProcessFields;       