var fm = require('./field-match');
var assert = require('assert');
var rpm = require('integration-common/api-wrappers');

// console.log(fm.SUPPORTED_DATA_TYPES);
var CORRECT_FIELD_TYPE = rpm.OBJECT_TYPE.CustomField;


function Field(name, subType) {
    this.Name = name;
    this.IsRepeating = false;
    this.FieldType = CORRECT_FIELD_TYPE;
    this.SubType = subType;
    this.UserCanEdit = true;
}

Field.prototype.getDefinitionRow = function () {
    for (var idx in this.Rows) {
        var row = this.Rows[idx];
        if (row.IsDefinition) {
            return row;
        }
    }
    return null;
};

function Fixture(correctSubType) {
    if (!correctSubType) {
        for (correctSubType in fm.SUPPORTED_DATA_TYPES) {
            break;
        }
        assert(correctSubType, 'No sub-types supported');
    }
    this.f1 = new Field('Field1', correctSubType);
    this.f2 = new Field('Field2', correctSubType);
    this.correctSubType = correctSubType;
}

Fixture.prototype.assertNormal = function () {
    fm.matchProcessFields(this.f1, this.f2);
};

Fixture.prototype.assertError = function (errorName, badField) {
    var self = this;
    assert.throws(
        function () {
            fm.matchProcessFields(self.f1, self.f2);
        },
        function (err) {
            return err instanceof Error && err.name === errorName && (!badField || err.field === badField);
        });
};

Fixture.prototype.assertFieldNotSupported = function (badField) {
    this.assertError('FieldNotSupportedError', badField);
};

Fixture.prototype.assertIncompatibleTypes = function () {
    this.assertError('IncompatibleTypesError');
};


function testBasic() {

    [
        function () {
            fm.matchProcessFields();
        },
        function () {
            fm.matchProcessFields({});
        },
        function () {
            fm.matchProcessFields(undefined, {});
        },
    ].forEach(function (func) {
        assert.throws(func, TypeError);
    });


    var fixture = new Fixture();
    fixture.assertNormal();
    var f1 = fixture.f1;
    var f2 = fixture.f2;

    var tested;
    [f1, f2].forEach(function (field) {

        field.IsRepeating = true;
        fixture.assertFieldNotSupported(field);
        field.IsRepeating = false;
        fixture.assertNormal();

        field.UserCanEdit = false;
        fixture.assertFieldNotSupported(field);
        field.UserCanEdit = true;
        fixture.assertNormal();

        tested = false;
        for (var key in rpm.OBJECT_TYPE) {
            var fieldType = rpm.OBJECT_TYPE[key];
            if (fieldType !== CORRECT_FIELD_TYPE) {
                field.FieldType = fieldType;
                fixture.assertFieldNotSupported(field);
                tested = true;
            }
        }
        assert(tested, 'Field types are not tested');
        field.FieldType = CORRECT_FIELD_TYPE;
        fixture.assertNormal();

        tested = false;
        for (var key in rpm.DATA_TYPE) {
            var subType = rpm.DATA_TYPE[key];
            if (!fm.SUPPORTED_DATA_TYPES[subType]) {
                field.SubType = subType;
                fixture.assertFieldNotSupported(field);
                tested = true;
            }
        }
        assert(tested, 'Unsupported sub0types are not tested');

        f1.SubType = fixture.correctSubType;
        f2.SubType = fixture.correctSubType;
    });
    fixture.assertNormal();

    for (var key1 in fm.SUPPORTED_DATA_TYPES) {
        var typeDesc = fm.SUPPORTED_DATA_TYPES[key1];
        if (typeDesc.hasRows || typeDesc.hasOptions) {
            continue;
        }
        for (var key2 in fm.SUPPORTED_DATA_TYPES) {
            typeDesc = fm.SUPPORTED_DATA_TYPES[key2];
            if (typeDesc.hasRows || typeDesc.hasOptions) {
                continue;
            }
            f1.SubType = key1;
            f2.SubType = key2;
            key1 == key2 ? fixture.assertNormal() : fixture.assertIncompatibleTypes();
        }
    }
    f1.SubType = fixture.correctSubType;
    f2.SubType = fixture.correctSubType;
    fixture.assertNormal();

}

function testTableFields() {

    var fixture;

    function assertNoDef(field) {
        fixture.assertError('NoTableDefinitionRowError', field);
    }

    function assertNoProp() {
        fixture.assertError('PropertyNotFoundError');
    }

    function assertRowsDontMatch() {
        fixture.assertError('RowsDontMatchError');
    }

    [rpm.DATA_TYPE.FieldTable, rpm.DATA_TYPE.FieldTableDefinedRow].forEach(function (subType) {
        fixture = new Fixture(subType);
        var f1 = fixture.f1;
        var f2 = fixture.f2;

        var tf11 = new Field('TF1', rpm.DATA_TYPE.Number);
        var tf12 = new Field('TF2', rpm.DATA_TYPE.Text);

        var tf21 = new Field(tf11.Name, tf11.SubType);
        var tf22 = new Field(tf12.Name, tf12.SubType);

        assertNoDef(f1);
        var defRow1 = {
            IsDefinition: false,
            IsLabelRow: true,
            Fields: [tf11, tf12]
        };
        f1.Rows = [defRow1];
        assertNoDef(f1);
        defRow1.IsDefinition = true;
        assertNoDef(f1);
        defRow1.IsLabelRow = false;

        assertNoDef(f2);

        var defRow2 = {
            IsDefinition: true,
            IsLabelRow: false,
            Fields: [tf21]
        };
        f2.Rows = [defRow2];
        assertNoProp();
        defRow2.Fields.push(tf22);


        tf11.Name = 'TF';
        assertNoProp();
        tf11.Name = 'TF1';
        tf12.SubType = rpm.DATA_TYPE.Html;

        fixture.assertIncompatibleTypes();

        tf22.SubType = rpm.DATA_TYPE.Html;
        fixture.assertNormal();

        defRow2.Fields.push(new Field('TF3', rpm.DATA_TYPE.Text));
        assertNoProp();
        defRow1.Fields.push(new Field('TF3', rpm.DATA_TYPE.Text));
        fixture.assertNormal();

        var dataRow1 = { Name: 'Xxx' };
        var dataRow2 = { Name: dataRow1.Name };

        f1.Rows.push(dataRow1);
        assertRowsDontMatch();
        f2.Rows.push(dataRow2);
        fixture.assertNormal();

        dataRow1.Name = 'Yyy';
        assertRowsDontMatch();
        dataRow2.Name = dataRow1.Name;
        fixture.assertNormal();
    });
}

function testOptionsFields() {

    var fixture;


    function assertDontMatch() {
        fixture.assertError('OptionsDontMatchError');
    }

    function assertNoOpts(field) {
        fixture.assertError('NoOptionsError',field);
    }

    [
        rpm.DATA_TYPE.List,
        rpm.DATA_TYPE.ListMultiSelect,
        rpm.DATA_TYPE.YesNoList,
        rpm.DATA_TYPE.LocationList,
    ].forEach(function (subType) {
        fixture = new Fixture(subType);
        var f1 = fixture.f1;
        var f2 = fixture.f2;
        assertNoOpts(f1);
        var o1 = {Text:'O1'};
        f1.Options = [o1];
        assertNoOpts(f2);
        var o2 = {Text:'O3'};
        f2.Options = [o2];
        assertDontMatch();
        o2.Text = o1.Text;
        o2.IsLabel = true;
        assertNoOpts(f2);
        o2.IsLabel = false;
        fixture.assertNormal();
        var o3 = {Text:'Extra', IsLabel: true};
        f2.Options.push(o3);
        fixture.assertNormal();
        o3.IsLabel = false;
        assertDontMatch();
        delete f2.Options[f2.Options.indexOf(o3)];
        fixture.assertNormal();
    });
}

testBasic();
testTableFields();
testOptionsFields();