#include "bsp.h"
#include <stdbool.h>

UART_HandleTypeDef huart2; /* nRF52840 NCP */
UART_HandleTypeDef huart3; /* Shell (ST-LINK VCP) */
DMA_HandleTypeDef  hdma_usart3_tx;

/* -----------------------------------------------------------------------
 * USART2 RX interrupt-driven ring buffer
 * ----------------------------------------------------------------------- */
#define UART2_RX_BUF_SIZE 512

static volatile uint8_t  uart2_rx_buf[UART2_RX_BUF_SIZE];
static volatile uint16_t uart2_rx_head = 0; /* ISR writes here */
static volatile uint16_t uart2_rx_tail = 0; /* reader consumes here */

void uart2_rx_isr(void)
{
    USART_TypeDef* usart = huart2.Instance;

    if (usart->ISR & USART_ISR_RXNE_RXFNE) {
        uint8_t  byte = (uint8_t)(usart->RDR & 0xFF);
        uint16_t next = (uart2_rx_head + 1) % UART2_RX_BUF_SIZE;
        if (next != uart2_rx_tail) {
            uart2_rx_buf[uart2_rx_head] = byte;
            uart2_rx_head = next;
        }
        /* If next == tail, buffer is full — drop byte */
    }

    /* Clear overrun if it occurred */
    if (usart->ISR & USART_ISR_ORE) {
        usart->ICR = USART_ICR_ORECF;
    }
}

size_t bsp_uart2_rx_available(void)
{
    uint16_t h = uart2_rx_head;
    uint16_t t = uart2_rx_tail;
    return (h >= t) ? (h - t) : (UART2_RX_BUF_SIZE - t + h);
}

bool bsp_uart2_rx_read(uint8_t* byte)
{
    if (uart2_rx_head == uart2_rx_tail) return false;
    *byte = uart2_rx_buf[uart2_rx_tail];
    uart2_rx_tail = (uart2_rx_tail + 1) % UART2_RX_BUF_SIZE;
    return true;
}

/**
 * Initialize UARTs:
 * - USART2: nRF52840 NCP Spinel/HDLC at 460800 baud, 8N1
 * - USART3: Debug shell at 115200 baud, 8N1 (ST-LINK VCP) + DMA TX
 */
void bsp_uart_init(void)
{
    /* --- USART2: nRF52840 NCP --- */
    __HAL_RCC_USART2_CLK_ENABLE();

    huart2.Instance = NRF_USART;
    huart2.Init.BaudRate = 460800;
    huart2.Init.WordLength = UART_WORDLENGTH_8B;
    huart2.Init.StopBits = UART_STOPBITS_1;
    huart2.Init.Parity = UART_PARITY_NONE;
    huart2.Init.Mode = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;

    if (HAL_UART_Init(&huart2) != HAL_OK) {
        while (1);
    }

    /* Enable USART2 RXNE interrupt for ring buffer */
    __HAL_UART_ENABLE_IT(&huart2, UART_IT_RXNE);
    HAL_NVIC_SetPriority(USART2_IRQn, 6, 0);
    HAL_NVIC_EnableIRQ(USART2_IRQn);

    /* --- USART3: Shell (ST-LINK VCP) --- */
    __HAL_RCC_USART3_CLK_ENABLE();
    __HAL_RCC_DMA1_CLK_ENABLE(); /* may already be enabled by SPI init */

    /* USART3 TX DMA: DMA1 Stream 2 */
    hdma_usart3_tx.Instance = DMA1_Stream2;
    hdma_usart3_tx.Init.Request = DMA_REQUEST_USART3_TX;
    hdma_usart3_tx.Init.Direction = DMA_MEMORY_TO_PERIPH;
    hdma_usart3_tx.Init.PeriphInc = DMA_PINC_DISABLE;
    hdma_usart3_tx.Init.MemInc = DMA_MINC_ENABLE;
    hdma_usart3_tx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
    hdma_usart3_tx.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;
    hdma_usart3_tx.Init.Mode = DMA_NORMAL;
    hdma_usart3_tx.Init.Priority = DMA_PRIORITY_MEDIUM;
    hdma_usart3_tx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
    HAL_DMA_Init(&hdma_usart3_tx);
    __HAL_LINKDMA(&huart3, hdmatx, hdma_usart3_tx);

    /* NVIC for DMA stream and USART3 */
    HAL_NVIC_SetPriority(DMA1_Stream2_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(DMA1_Stream2_IRQn);
    HAL_NVIC_SetPriority(USART3_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(USART3_IRQn);

    huart3.Instance = SHELL_USART;
    huart3.Init.BaudRate = 115200;
    huart3.Init.WordLength = UART_WORDLENGTH_8B;
    huart3.Init.StopBits = UART_STOPBITS_1;
    huart3.Init.Parity = UART_PARITY_NONE;
    huart3.Init.Mode = UART_MODE_TX_RX;
    huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart3.Init.OverSampling = UART_OVERSAMPLING_16;

    if (HAL_UART_Init(&huart3) != HAL_OK) {
        while (1);
    }
}

void bsp_uart2_set_baud(uint32_t baud)
{
    /* Disable USART2 IRQ during reconfiguration */
    HAL_NVIC_DisableIRQ(USART2_IRQn);
    __HAL_UART_DISABLE_IT(&huart2, UART_IT_RXNE);

    huart2.Init.BaudRate = baud;
    HAL_UART_Init(&huart2);

    /* Re-enable RX interrupt */
    __HAL_UART_ENABLE_IT(&huart2, UART_IT_RXNE);
    HAL_NVIC_EnableIRQ(USART2_IRQn);
}
