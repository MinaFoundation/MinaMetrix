// IMPORTANT NOTES!
// This class is a shadow model, should not be directly accessed in any way by a controller. It is managed by CronJob scripts
// There is no type checks etc. on the data, as it is assumed that the data is already validated by the CronJob scripts.
// None of the static functions of the class returns anything but the errors, as this is a closed model.

const async = require('async');
const mongoose = require('mongoose');

const gitAPIRequest = require('../../utils/gitAPIRequest');
const toMongoId = require('../../utils/toMongoId')

const Repository = require('../repository/Repository');

const generateKey = require('./functions/generateKey');

const DUPLICATED_UNIQUE_FIELD_ERROR_CODE = 11000;
const MAX_DATABASE_TEXT_FIELD_LENGTH = 1e4;
const MAX_DATABASE_OBJECT_KEY_COUNT = 1e3;
const MAX_DOCUMENT_COUNT_PER_QUERY = 1e3;
const MIN_PRIORITY_VALUE = 0;
const BACKLOG_FINISH_TIME = 2 * 24 * 60 * 60 * 1000;
const STATUS_CODES = {
  indexing: 0,
  not_o1js: 1,
  o1js: 2
};
const TYPE_PRIORITY_MAP = {
  'force_repo_update': 0,
  'manual_repo_update': 0,
  'repo_update': 1,
  'keyword_search': 2,
  'language_search': 2
};
const TYPE_VALUES = ['force_repo_update', 'keyword_search', 'language_search', 'manual_repo_update', 'repo_update'];

const Schema = mongoose.Schema;

const TaskSchema = new Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 1,
    maxlength: MAX_DATABASE_TEXT_FIELD_LENGTH
  },
  priority: {
    type: Number,
    required: true,
    min: MIN_PRIORITY_VALUE
  },
  type: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: MAX_DATABASE_TEXT_FIELD_LENGTH
  },
  data: {
    type: Object,
    default: {}
  },
  backlog: {
    type: Number,
    default: null,
    index: true,
    min: 0
  },
  has_been_in_backlog: {
    type: Boolean,
    default: false
  }
});

TaskSchema.statics.findTaskByIdAndReturnIfPerformed = function (id, callback) {
  const Task = this;

  if (!id || !toMongoId(id))
    return callback('bad_request');

  Task.findById(toMongoId(id), (err, task) => {
    if (err) return callback('database_error');

    if (task) return callback(null, false);
    else return callback(null, true);
  });
};

TaskSchema.statics.createTask = function (data, callback) {
  const Task = this;

  if (!data || typeof data != 'object')
    return callback('bad_request');

  if (!data.type || typeof data.type != 'string' || !TYPE_VALUES.includes(data.type))
    return callback('bad_request');

  if (!data.data || typeof data.data != 'object' || !Object.keys(data.data).length || Object.keys(data.data).length > MAX_DATABASE_OBJECT_KEY_COUNT)
    return callback('bad_request');

  const key = generateKey(data);

  if (!key) return callback('bad_request');

  const newTask = new Task({
    key,
    priority: TYPE_PRIORITY_MAP[data.type],
    type: data.type,
    data: data.data,
    backlog: data.backlog && !isNaN(parseInt(data.backlog)) ? parseInt(data.backlog) : null,
    has_been_in_backlog: 'has_been_in_backlog' in data && typeof data.has_been_in_backlog == 'boolean' ? data.has_been_in_backlog : false
  });

  newTask.save((err, task) => {
    if (err && err.code == DUPLICATED_UNIQUE_FIELD_ERROR_CODE) {
      Task.findOne({
        key
      }, (err, task) => {
        if (err) return callback('database_error');

        return callback(null, task);
      });
    } else {
      if (err) return callback(err);

      return callback(null, task);
    }
  });
};

TaskSchema.statics.performLatestTask = function (callback) {
  const Task = this;

  Task
    .find({
      backlog: null
    })
    .sort({
      priority: 1,
      _id: -1
    })
    .limit(1)
    .then(tasks => {
      if (!tasks || !tasks.length)
        return callback(null);

      const task = tasks[0];

      console.log('Current Task: ', task.key);

      gitAPIRequest(task.type, task.data, (err, result) => {
        if (task.type == 'force_repo_update' || task.type == 'manual_repo_update'|| task.type == 'repo_update')
          console.log('API Request Result: ', err, result);
        else
          console.log('API Request Result: ', err, result.data ? result.data.length : 0)

        if (err) {
          if (err == 'document_not_found')
            Task.findTaskByIdAndDelete(task._id, err => {
              if (err) return callback(err);

              return callback(null);
            });
          else
            Task.findTaskByIdAndRecreate(task._id, err => {
              if (err) return callback(err);

              return callback(null);
            });
        } else {
          // if (task.type == 'force_repo_update') {
          //   Repository.createOrUpdateRepository({
          //     github_id: result.data.id,
          //     title: result.data.name,
          //     url: `https://github.com/${result.owner_name}/${result.title}`
          //   }, (err, repository) => {
          //     if (err && (err == 'document_already_exists' || err == 'duplicated_unique_field'))
          //       return next(null);
          //     if (err) {
          //       console.log('Force Repo Update Error: ', err);
          //       return next(null);
          //     }

          //     Task.findTaskByIdAndDelete(task._id, err => {
          //       if (err) return callback(err);

          //       return callback(null);
          //     });
          //   });
          // } else 
          if (task.type == 'repo_update') {
            if (!task.data || !task.data.github_id)
              return callback('unknown_error');

            const github_id = task.data.github_id;
  
            if (result.status == STATUS_CODES.indexing) {
              if (task.has_been_in_backlog) {
                Repository.findRepositoryByGitHubIdAndCompletelyDelete(github_id, err => {
                  if (err) return callback(err);
    
                  Task.findTaskByIdAndDelete(task._id, err => {
                    if (err) return callback(err);

                    return callback(null);
                  });
                });
              } else {
                Task.findTaskByIdAndRecreate(task._id, err => {
                  if (err) return callback(err);
    
                  return callback(null);
                });
              };
            } else if (result.status == STATUS_CODES.not_o1js) {
              Repository.findRepositoryByGitHubIdAndDelete(github_id, err => {
                if (err) return callback(err);
  
                Task.findTaskByIdAndDelete(task._id, err => {
                  if (err) return callback(err);
  
                  return callback(null);
                });
              });
            } else if (result.status == STATUS_CODES.o1js) {
              if (!result.data) return callback('unknown_error');
  
              const update = result.data;
              update.is_checked = true;
  
              Repository.findRepositoryByGitHubIdAndUpdate(github_id, update, err => {
                if (err) return callback(err);
  
                Task.findTaskByIdAndDelete(task._id, err => {
                  if (err) return callback(err);
  
                  return callback(null);
                });
              });
            };
          } else if (task.type == 'manual_repo_update') {
            if (!task.data || !task.data.github_id)
              return callback('unknown_error');

            if (result.status == STATUS_CODES.o1js) {
              if (!result.data) return callback('unknown_error');
  
              const update = result.data;
              update.is_checked = true;

              Repository.createOrUpdateRepository(update, err => {
                if (err) return callback(err);
  
                Task.findTaskByIdAndDelete(task._id, err => {
                  if (err) return callback(err);
  
                  return callback(null);
                });
              });
            } else {
              Task.findTaskByIdAndDelete(task._id, err => {
                if (err) return callback(err);

                return callback(null);
              });
            };
          } else if (task.type == 'keyword_search' || task.type == 'language_search') {
            if (!result.data || !Array.isArray(result.data))
              return callback('unknown_error');

            const repositories = result.data;

            Task.findTaskByIdAndDelete(task._id, err => {
              if (err) return callback(err);

              callback(null); // Create tasks async

              let createdCount = 0;

              async.timesSeries(
                repositories.length,
                (time, next) => {
                  const data = repositories[time];
    
                  if (!data) return next('unknown_error');
  
                  data.is_checked = false;
  
                  Repository.createOrUpdateRepository(data, (err, repository) => {
                    if (err && (err == 'document_already_exists' || err == 'duplicated_unique_field'))
                      return next(null);
                    if (err) {
                      console.log(`Create Search Results Error (${new Date}): ${err}`)
                      return next(null);
                    }

                    // TODO: Optimize this
                    // if (repository.is_checked)
                    //   return next();
  
                    Task.createTask({
                      type: 'repo_update',
                      data: {
                        github_id: repository.github_id,
                        owner_name: data.owner.login,
                        title: repository.title
                      }
                    }, err => {
                      if (err) {
                        console.log(`Create Search Results Error (${new Date}): ${err}`)
                        return next(null);
                      }
    
                      createdCount++;
                      return next();
                    });
                  });
                },
                _ => {
                  console.log(`Search Results Created (${new Date}). Type: ${task.type}, Count: ${createdCount}`);
                }
              );
            });
          } else {
            return callback('unknown_error');
          }
        }
      });
    })
    .catch(_ => callback('database_error'));
};

TaskSchema.statics.findTaskByIdAndDelete = function (id, callback) {
  const Task = this;

  if (!id || !toMongoId(id))
    return callback('bad_request');

  Task.findByIdAndDelete(toMongoId(id), err => {
    if (err) return callback('database_error');

    return callback(null);
  });
};

TaskSchema.statics.findTaskByIdAndRecreate = function (id, callback)  {
  const Task = this;

  if (!id || !toMongoId(id))
    return callback('bad_request');

  Task.findByIdAndDelete(toMongoId(id), (err, task) => {
    if (err) return callback('database_error');
    if (!task) return callback(null);

    Task.createTask({
      type: task.type,
      data: task.data,
      backlog: Date.now() + BACKLOG_FINISH_TIME,
      has_been_in_backlog: true
    }, (err, task) => callback(err, task));
  });
};

TaskSchema.statics.checkBacklog = function (callback) {
  const Task = this;

  Task
    .find({
      backlog: { $ne: null }
    })
    .sort({
      backlog: 1
    })
    .limit(MAX_DOCUMENT_COUNT_PER_QUERY)
    .then(tasks => async.timesSeries(
      tasks.length,
      (time, next) => {
        const task = tasks[time];

        if (task.backlog > Date.now())
          return next('force_stop');

        Task.findByIdAndUpdate(task._id, {$set: {
          backlog: null
        }}, err => next(err, 1));
      },
      (err, results) => {
        if (err && err != 'force_stop')
          return callback(err);

        console.log(`Backlog Checked (${new Date}). Created Task Count: ${results.length}`);

        return callback(null);
      }
    ))
    .catch(_ => callback('database_error'))
};

TaskSchema.statics.checkIfThereIsAnyTask = function (callback) {
  const Task = this;

  Task.findOne({
    $or: [
      { type: 'keyword_search' },
      { type: 'language_search' },
      { backlog: null },
      { backlog: { $lt: Date.now() } }
    ]
  }, (err, task) => {
    if (err) return callback('database_error');

    if (task)
      return callback(null, true);
    
    return callback(null, false);
  });
};

TaskSchema.statics.createManuelRepositoryUpdateTask = function (data, callback) {
  const Task = this;

  if (!data || typeof data != 'object')
    return callback('bad_request');

  if (!data.repositories || !Array.isArray(data.repositories) || !data.repositories.length || data.repositories.find(any => typeof any != 'object' || !any.owner_name || !any.title))
    return callback('bad_request');

  async.timesSeries(
    data.repositories.length,
    (time, next) => Task.createTask({
      type: 'manual_repo_update',
      data: data.repositories[time]
    }, err => next(err)),
    err => {
      if (err) return callback(err);

      return callback(null);
    }
  );
};

module.exports = mongoose.model('Task', TaskSchema);
