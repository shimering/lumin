const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(language = 'en') {
  const context = vm.createContext({ currentUiLanguage: language });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lumin-finance-sync.js'), 'utf8'), context);
  return context;
}

test('Baytna children use their stable parent key and an unambiguous selected path', () => {
  const categories = [
    { key: 'clinic-child', kind: 'expense', name: 'Supplies', parent_key: 'clinic' },
    { key: 'home-child', kind: 'expense', name: 'Supplies', parent_key: 'home' },
    { key: 'clinic', kind: 'expense', name: 'Clinic' },
    { key: 'home', kind: 'expense', name: 'Home' },
    { key: 'income', kind: 'income', name: 'Income' }
  ];
  const choices = load().financeSyncCategoryChoices('expense', categories);
  assert.deepEqual(Array.from(choices, item => item.path), ['Clinic', 'Clinic › Supplies', 'Home', 'Home › Supplies']);
  assert.equal(choices[1].depth, 1);
  assert.equal(choices[1].parentName, 'Clinic');
  assert.equal(choices[1].groupKey, 'clinic');
});

test('Arabic category paths use Arabic parent and child labels', () => {
  const choices = load('ar').financeSyncCategoryChoices('income', [
    { key: 'salary', kind: 'income', name: 'Salary', name_ar: 'الراتب' },
    { key: 'clinic', kind: 'income', name: 'Clinic', name_ar: 'العيادة', parent_key: 'salary' }
  ]);
  assert.equal(choices.find(item => item.key === 'clinic').path, 'الراتب › العيادة');
});

test('Unknown parents and cyclic category references cannot hang the picker', () => {
  const choices = load().financeSyncCategoryChoices('expense', [
    { key: 'orphan', kind: 'expense', name: 'Child', parent_key: 'missing', parent_name: 'Archived parent' },
    { key: 'a', kind: 'expense', name: 'A', parent_key: 'b' },
    { key: 'b', kind: 'expense', name: 'B', parent_key: 'a' }
  ]);
  assert.equal(choices.length, 3);
  assert.equal(choices.find(item => item.key === 'orphan').path, 'Archived parent › Child');
});
