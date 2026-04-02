/* Minimal STM32 HAL stub for host-side unit tests */
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* HAL tick */
uint32_t HAL_GetTick(void);

/* Minimal GPIO/SPI/EXTI type stubs so bsp.h compiles */
typedef struct { volatile uint32_t dummy; } SPI_TypeDef;
typedef struct { volatile uint32_t dummy; } GPIO_TypeDef;
typedef uint32_t IRQn_Type;

#define SPI3            ((SPI_TypeDef*)0)
#define GPIOA           ((GPIO_TypeDef*)0)
#define GPIOB           ((GPIO_TypeDef*)0)
#define GPIOC           ((GPIO_TypeDef*)0)
#define GPIOD           ((GPIO_TypeDef*)0)
#define GPIOE           ((GPIO_TypeDef*)0)
#define GPIO_PIN_0      ((uint32_t)0x0001)
#define GPIO_PIN_1      ((uint32_t)0x0002)
#define GPIO_PIN_4      ((uint32_t)0x0010)
#define GPIO_PIN_5      ((uint32_t)0x0020)
#define GPIO_PIN_10     ((uint32_t)0x0400)
#define GPIO_PIN_11     ((uint32_t)0x0800)
#define GPIO_PIN_12     ((uint32_t)0x1000)
#define GPIO_PIN_13     ((uint32_t)0x2000)
#define GPIO_PIN_14     ((uint32_t)0x4000)
#define GPIO_PIN_15     ((uint32_t)0x8000)
#define EXTI0_IRQn      ((IRQn_Type)6)
#define EXTI1_IRQn      ((IRQn_Type)7)
#define EXTI2_IRQn      ((IRQn_Type)8)
#define EXTI3_IRQn      ((IRQn_Type)9)
