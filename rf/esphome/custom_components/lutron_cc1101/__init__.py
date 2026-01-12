import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import spi
from esphome import pins, automation
from esphome.const import CONF_ID, CONF_TRIGGER_ID
import os

DEPENDENCIES = ['spi']
CODEOWNERS = ['@custom']

lutron_cc1101_ns = cg.esphome_ns.namespace('lutron_cc1101')
LutronCC1101 = lutron_cc1101_ns.class_('LutronCC1101', cg.Component, spi.SPIDevice)

# Trigger type for on_packet - receives vector<uint8_t> and int32 rssi
LutronPacketTrigger = lutron_cc1101_ns.class_(
    'LutronPacketTrigger',
    automation.Trigger.template(cg.std_vector.template(cg.uint8), cg.int32)
)

# Trigger type for on_tx - receives vector<uint8_t> only (no RSSI for TX)
LutronTxTrigger = lutron_cc1101_ns.class_(
    'LutronTxTrigger',
    automation.Trigger.template(cg.std_vector.template(cg.uint8))
)

CONF_GDO0_PIN = 'gdo0_pin'
CONF_ON_PACKET = 'on_packet'
CONF_ON_TX = 'on_tx'

CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(LutronCC1101),
    cv.Optional(CONF_GDO0_PIN): pins.gpio_input_pin_schema,
    cv.Optional(CONF_ON_PACKET): automation.validate_automation({
        cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(LutronPacketTrigger),
    }),
    cv.Optional(CONF_ON_TX): automation.validate_automation({
        cv.GenerateID(CONF_TRIGGER_ID): cv.declare_id(LutronTxTrigger),
    }),
}).extend(cv.COMPONENT_SCHEMA).extend(spi.spi_device_schema(cs_pin_required=True))

async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await spi.register_spi_device(var, config)

    if CONF_GDO0_PIN in config:
        gdo0_pin = await cg.gpio_pin_expression(config[CONF_GDO0_PIN])
        cg.add(var.set_gdo0_pin(gdo0_pin))

    # Register on_packet trigger (RX packets)
    for conf in config.get(CONF_ON_PACKET, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [(cg.std_vector.template(cg.uint8), 'data'), (cg.int32, 'rssi')], conf)

    # Register on_tx trigger (TX packets)
    for conf in config.get(CONF_ON_TX, []):
        trigger = cg.new_Pvariable(conf[CONF_TRIGGER_ID], var)
        await automation.build_automation(trigger, [(cg.std_vector.template(cg.uint8), 'data')], conf)

    # Link Rust CCA library for protocol decoding/encoding
    # Library is built separately via: cargo +esp build --target xtensa-esp32-none-elf --no-default-features --features embedded --lib -Zbuild-std=core,alloc --release
    cca_lib_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'cca', 'target', 'xtensa-esp32-none-elf', 'release'))
    cca_header_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'cca'))

    cg.add_build_flag(f'-I{cca_header_dir}')
    cg.add_build_flag(f'-L{cca_lib_dir}')
    cg.add_build_flag('-lcca')
