'use strict';

exports.up = async function(knex) {
  if (!(await knex.schema.hasTable('whatsapp_configs'))) {
    await knex.schema.createTable('whatsapp_configs', (table) => {
      table.increments('id').primary();
      table.string('phone_number_id', 255).notNullable().defaultTo('');
      table.string('waba_id', 255).notNullable().defaultTo('');
      table.string('access_token', 1000).notNullable().defaultTo('');
      table.string('template_name', 255).notNullable().defaultTo('gallery_ready');
      table.boolean('enabled').defaultTo(false);
      table.datetime('updated_at').defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('whatsapp_queue'))) {
    await knex.schema.createTable('whatsapp_queue', (table) => {
      table.increments('id').primary();
      table.integer('event_id').references('id').inTable('events');
      table.string('recipient_phone', 50).notNullable();
      table.string('message_type', 50).notNullable();
      table.json('message_data');
      table.string('status', 20).defaultTo('pending');
      table.integer('retry_count').defaultTo(0);
      table.datetime('created_at').defaultTo(knex.fn.now());
      table.datetime('scheduled_at').defaultTo(knex.fn.now());
      table.datetime('sent_at');
      table.text('error_message');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('whatsapp_queue');
  await knex.schema.dropTableIfExists('whatsapp_configs');
};
