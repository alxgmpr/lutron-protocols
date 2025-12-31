import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import spi
from esphome import pins
from esphome.const import CONF_ID

DEPENDENCIES = ['spi']

lutron_cc1101_ns = cg.esphome_ns.namespace('lutron_cc1101')
LutronCC1101 = lutron_cc1101_ns.class_('LutronCC1101', cg.Component, spi.SPIDevice)

CONF_GDO0_PIN = 'gdo0_pin'

CONFIG_SCHEMA = cv.Schema({
    cv.GenerateID(): cv.declare_id(LutronCC1101),
    cv.Optional(CONF_GDO0_PIN): pins.gpio_input_pin_schema,
}).extend(cv.COMPONENT_SCHEMA).extend(spi.spi_device_schema(cs_pin_required=True))

async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    await spi.register_spi_device(var, config)

    if CONF_GDO0_PIN in config:
        gdo0_pin = await cg.gpio_pin_expression(config[CONF_GDO0_PIN])
        cg.add(var.set_gdo0_pin(gdo0_pin))
