/**
 * Ethernet MAC + PHY initialization for Nucleo-H723ZG.
 *
 * Uses STM32H7 ETH peripheral in RMII mode with LAN8742A PHY.
 * lwIP integration via FreeRTOS (tcpip_init + DHCP).
 *
 * DMA descriptors and RX buffers are placed in RAM_D2 (0x30000000)
 * via __attribute__((section(".eth_mem"))) — required because the
 * STM32H7 Ethernet DMA can only access AHB SRAM in the D2 domain.
 *
 * Buffer management uses weak HAL callback overrides:
 *   - HAL_ETH_RxAllocateCallback: provides RX buffers from pre-allocated pool
 *   - HAL_ETH_RxLinkCallback: builds pbuf chains from received frame segments
 *
 * RX processing uses a dedicated FreeRTOS task (not ISR context) to avoid
 * calling pbuf_alloc and tcpip_input from interrupt handlers.
 */

#include "eth.h"
#include "bsp.h"

#include "lwip/init.h"
#include "lwip/netif.h"
#include "lwip/tcpip.h"
#include "lwip/dhcp.h"
#include "lwip/ip_addr.h"
#include "lwip/etharp.h"
#include "lwip/pbuf.h"
#include "lwip/timeouts.h"
#include "netif/ethernet.h"

#include "FreeRTOS.h"
#include "semphr.h"
#include "task.h"

#include <stdio.h>
#include <string.h>

/* -----------------------------------------------------------------------
 * ETH handle and lwIP netif
 * ----------------------------------------------------------------------- */
ETH_HandleTypeDef   heth;
static struct netif gnetif;
static char         ip_str[16] = "0.0.0.0";
static bool         link_up = false;

/* TX complete semaphore — signals when DMA is done with a frame */
static SemaphoreHandle_t tx_sem = NULL;

/* RX semaphore — ISR signals task to process received frames */
static SemaphoreHandle_t rx_sem = NULL;

/* MAC address array (ETH_InitTypeDef.MACAddr is a pointer) */
static uint8_t mac_addr[6] = {ETH_MAC_ADDR0, ETH_MAC_ADDR1, ETH_MAC_ADDR2, ETH_MAC_ADDR3, ETH_MAC_ADDR4, ETH_MAC_ADDR5};

/* -----------------------------------------------------------------------
 * Ethernet DMA descriptors + buffers in RAM_D2
 * ----------------------------------------------------------------------- */
#define ETH_RX_BUF_SIZE 1536

__attribute__((section(".eth_mem"), aligned(4))) static ETH_DMADescTypeDef dma_rx_desc_tab[ETH_RX_DESC_CNT];

__attribute__((section(".eth_mem"), aligned(4))) static ETH_DMADescTypeDef dma_tx_desc_tab[ETH_TX_DESC_CNT];

__attribute__((section(".eth_mem"), aligned(4))) static uint8_t rx_buff[ETH_RX_DESC_CNT][ETH_RX_BUF_SIZE];

/* RX buffer allocation index (round-robin through pre-allocated pool) */
static volatile uint8_t rx_alloc_idx = 0;

/* Debug counters */
static volatile uint32_t eth_tx_ok = 0, eth_tx_fail = 0;
static volatile uint32_t eth_rx_frames = 0;

/* -----------------------------------------------------------------------
 * Forward declarations
 * ----------------------------------------------------------------------- */
static err_t ethernetif_init(struct netif* netif);
static err_t ethernetif_linkoutput(struct netif* netif, struct pbuf* p);

/* -----------------------------------------------------------------------
 * HAL ETH RX callbacks (weak overrides — no REGISTER_CALLBACKS needed)
 * ----------------------------------------------------------------------- */

/**
 * Called by HAL ETH_UpdateDescriptor to get an RX buffer for a DMA descriptor.
 * We provide buffers from our pre-allocated pool in RAM_D2.
 */
void HAL_ETH_RxAllocateCallback(uint8_t** buffer)
{
    *buffer = rx_buff[rx_alloc_idx];
    rx_alloc_idx = (rx_alloc_idx + 1) % ETH_RX_DESC_CNT;
}

/**
 * Called by HAL_ETH_ReadData for each received frame segment.
 * Builds a pbuf chain that gets returned via pStart.
 *
 * NOTE: This is called from the RX task (not ISR) since we moved
 * HAL_ETH_ReadData out of the interrupt handler.
 */
void HAL_ETH_RxLinkCallback(void** pStart, void** pEnd, uint8_t* buff, uint16_t Length)
{
    struct pbuf* p = pbuf_alloc(PBUF_RAW, Length, PBUF_POOL);
    if (p == NULL) return;

    memcpy(p->payload, buff, Length);

    if (*pStart == NULL) {
        *pStart = p;
    }
    else if (*pEnd != NULL) {
        /* Use pbuf_cat for proper chaining (updates tot_len) */
        pbuf_cat((struct pbuf*)*pStart, p);
    }
    *pEnd = p;
}

/* -----------------------------------------------------------------------
 * Netif status callback — log IP address
 * ----------------------------------------------------------------------- */
static void netif_status_cb(struct netif* netif)
{
    if (netif_is_up(netif) && !ip4_addr_isany_val(*netif_ip4_addr(netif))) {
        snprintf(ip_str, sizeof(ip_str), "%s", ip4addr_ntoa(netif_ip4_addr(netif)));
        printf("[eth] DHCP assigned IP: %s\r\n", ip_str);
        link_up = true;
    }
    else {
        snprintf(ip_str, sizeof(ip_str), "0.0.0.0");
        link_up = false;
    }
}

/* -----------------------------------------------------------------------
 * ETH RX task — processes received frames in task context
 * ----------------------------------------------------------------------- */
static void eth_rx_task(void* param)
{
    (void)param;

    for (;;) {
        /* Wait for ISR to signal that frames are available */
        if (xSemaphoreTake(rx_sem, portMAX_DELAY) == pdTRUE) {
            struct pbuf* p = NULL;

            while (HAL_ETH_ReadData(&heth, (void**)&p) == HAL_OK) {
                if (p != NULL) {
                    eth_rx_frames++;
                    if (gnetif.input(p, &gnetif) != ERR_OK) {
                        pbuf_free(p);
                    }
                    p = NULL;
                }
            }
        }
    }
}

/* -----------------------------------------------------------------------
 * ETH init
 * ----------------------------------------------------------------------- */
void bsp_eth_init(void)
{
    printf("[eth] Initializing Ethernet MAC + LAN8742A PHY...\r\n");

    __HAL_RCC_ETH1MAC_CLK_ENABLE();
    __HAL_RCC_ETH1TX_CLK_ENABLE();
    __HAL_RCC_ETH1RX_CLK_ENABLE();

    /* Configure ETH handle */
    memset(&heth, 0, sizeof(heth));
    heth.Instance = ETH;
    heth.Init.MACAddr = mac_addr;
    heth.Init.MediaInterface = HAL_ETH_RMII_MODE;
    heth.Init.RxBuffLen = ETH_RX_BUF_SIZE;
    heth.Init.TxDesc = dma_tx_desc_tab;
    heth.Init.RxDesc = dma_rx_desc_tab;

    if (HAL_ETH_Init(&heth) != HAL_OK) {
        printf("[eth] ERROR: HAL_ETH_Init failed!\r\n");
        return;
    }

    /* TX complete semaphore */
    tx_sem = xSemaphoreCreateBinary();
    xSemaphoreGive(tx_sem);

    /* RX semaphore — signaled by ISR */
    rx_sem = xSemaphoreCreateBinary();

    /* ETH interrupt */
    HAL_NVIC_SetPriority(ETH_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(ETH_IRQn);

    /* Start RX processing task */
    xTaskCreate(eth_rx_task, "EthRx", 512, NULL, 4, NULL);

    /* Initialize lwIP with FreeRTOS */
    tcpip_init(NULL, NULL);

    /* Configure netif */
    ip4_addr_t ipaddr, netmask, gateway;

    /* Start with 0.0.0.0 — DHCP will assign real address */
    ip4_addr_set_zero(&ipaddr);
    ip4_addr_set_zero(&netmask);
    ip4_addr_set_zero(&gateway);

    netif_add(&gnetif, &ipaddr, &netmask, &gateway, NULL, ethernetif_init, tcpip_input);
    netif_set_default(&gnetif);
    netif_set_up(&gnetif);
    netif_set_status_callback(&gnetif, netif_status_cb);

    /* Start DHCP (will actually send after link comes up) */
    LOCK_TCPIP_CORE();
    dhcp_start(&gnetif);
    UNLOCK_TCPIP_CORE();

    printf("[eth] DHCP client started, waiting for IP...\r\n");
}

const char* eth_get_ip_str(void)
{
    return ip_str;
}

bool eth_link_is_up(void)
{
    return link_up;
}

/* LAN8742A PHY register addresses */
#define PHY_BSR             0x01 /* Basic Status Register */
#define PHY_BSR_LINK_STATUS (1U << 2)

/* LAN8742A Special Control/Status Register */
#define PHY_SCSR            0x1F
#define PHY_SCSR_SPEED_MASK (0x1CU) /* bits [4:2] */
#define PHY_SCSR_100BTX_FD  (0x18U) /* 100Base-TX full duplex */
#define PHY_SCSR_100BTX_HD  (0x08U) /* 100Base-TX half duplex */
#define PHY_SCSR_10BT_FD    (0x14U) /* 10Base-T full duplex */
#define PHY_SCSR_10BT_HD    (0x04U) /* 10Base-T half duplex */

void eth_poll_link(void)
{
    uint32_t    regval = 0;
    static bool prev_link = false;

    if (HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, PHY_BSR, &regval) != HAL_OK) {
        return;
    }

    bool phy_link = (regval & PHY_BSR_LINK_STATUS) != 0;

    if (phy_link && !prev_link) {
        printf("[eth] PHY link UP (BSR=0x%04lX)\r\n", (unsigned long)regval);

        /* Read negotiated speed/duplex from PHY SCSR */
        uint32_t scsr = 0;
        HAL_ETH_ReadPHYRegister(&heth, LAN8742A_PHY_ADDR, PHY_SCSR, &scsr);

        /* Configure MAC to match PHY */
        ETH_MACConfigTypeDef mac_cfg;
        HAL_ETH_GetMACConfig(&heth, &mac_cfg);

        uint32_t speed_bits = scsr & PHY_SCSR_SPEED_MASK;
        if (speed_bits == PHY_SCSR_100BTX_FD) {
            mac_cfg.DuplexMode = ETH_FULLDUPLEX_MODE;
            mac_cfg.Speed = ETH_SPEED_100M;
            printf("[eth] 100 Mbps Full Duplex\r\n");
        }
        else if (speed_bits == PHY_SCSR_100BTX_HD) {
            mac_cfg.DuplexMode = ETH_HALFDUPLEX_MODE;
            mac_cfg.Speed = ETH_SPEED_100M;
            printf("[eth] 100 Mbps Half Duplex\r\n");
        }
        else if (speed_bits == PHY_SCSR_10BT_FD) {
            mac_cfg.DuplexMode = ETH_FULLDUPLEX_MODE;
            mac_cfg.Speed = ETH_SPEED_10M;
            printf("[eth] 10 Mbps Full Duplex\r\n");
        }
        else {
            mac_cfg.DuplexMode = ETH_HALFDUPLEX_MODE;
            mac_cfg.Speed = ETH_SPEED_10M;
            printf("[eth] 10 Mbps Half Duplex\r\n");
        }

        HAL_ETH_SetMACConfig(&heth, &mac_cfg);

        /* Start ETH DMA — calls HAL_ETH_RxAllocateCallback to fill descriptors */
        HAL_StatusTypeDef eth_start = HAL_ETH_Start_IT(&heth);
        printf("[eth] HAL_ETH_Start_IT = %d (state=%d)\r\n", eth_start, (int)heth.gState);

        LOCK_TCPIP_CORE();
        netif_set_link_up(&gnetif);
        dhcp_start(&gnetif);
        UNLOCK_TCPIP_CORE();
    }
    else if (!phy_link && prev_link) {
        printf("[eth] PHY link DOWN\r\n");
        LOCK_TCPIP_CORE();
        netif_set_link_down(&gnetif);
        UNLOCK_TCPIP_CORE();
        HAL_ETH_Stop_IT(&heth);
        link_up = false;
        snprintf(ip_str, sizeof(ip_str), "0.0.0.0");
    }

    prev_link = phy_link;
}

/* -----------------------------------------------------------------------
 * lwIP ethernetif callbacks
 * ----------------------------------------------------------------------- */
static err_t ethernetif_init(struct netif* netif)
{
    netif->name[0] = 's';
    netif->name[1] = 't';
    netif->output = etharp_output;
    netif->linkoutput = ethernetif_linkoutput;
    netif->hwaddr_len = 6;
    memcpy(netif->hwaddr, mac_addr, 6);
    netif->mtu = 1500;
    netif->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_ETHARP;

    return ERR_OK;
}

/* TX buffer must be in D2 SRAM — ETH DMA cannot access D1 RAM */
__attribute__((section(".eth_mem"), aligned(4))) static uint8_t tx_data[ETH_RX_BUF_SIZE];

static err_t ethernetif_linkoutput(struct netif* netif, struct pbuf* p)
{
    (void)netif;

    ETH_BufferTypeDef tx_buf;
    memset(&tx_buf, 0, sizeof(tx_buf));

    /* Copy pbuf chain into contiguous TX buffer (in D2 SRAM) */
    size_t offset = 0;
    for (const struct pbuf* q = p; q != NULL; q = q->next) {
        if (offset + q->len > sizeof(tx_data)) break;
        memcpy(tx_data + offset, q->payload, q->len);
        offset += q->len;
    }

    tx_buf.buffer = tx_data;
    tx_buf.len = (uint32_t)offset;
    tx_buf.next = NULL;

    ETH_TxPacketConfigTypeDef tx_config;
    memset(&tx_config, 0, sizeof(tx_config));
    tx_config.Attributes = ETH_TX_PACKETS_FEATURES_CRCPAD;
    tx_config.CRCPadCtrl = ETH_CRC_PAD_INSERT;
    tx_config.Length = (uint32_t)offset;
    tx_config.TxBuffer = &tx_buf;

    /* Wait for previous TX to complete (with timeout) */
    if (xSemaphoreTake(tx_sem, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ERR_TIMEOUT;
    }

    HAL_StatusTypeDef status = HAL_ETH_Transmit_IT(&heth, &tx_config);
    if (status != HAL_OK) {
        eth_tx_fail++;
        xSemaphoreGive(tx_sem); /* Release on failure */
        return ERR_IF;
    }
    eth_tx_ok++;
    return ERR_OK;
}

/* -----------------------------------------------------------------------
 * ETH IRQ callbacks — minimal work, signal tasks
 * ----------------------------------------------------------------------- */
void HAL_ETH_TxCpltCallback(ETH_HandleTypeDef* h)
{
    (void)h;
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    xSemaphoreGiveFromISR(tx_sem, &xHigherPriorityTaskWoken);
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}

void HAL_ETH_RxCpltCallback(ETH_HandleTypeDef* h)
{
    (void)h;
    BaseType_t xHigherPriorityTaskWoken = pdFALSE;
    xSemaphoreGiveFromISR(rx_sem, &xHigherPriorityTaskWoken);
    portYIELD_FROM_ISR(xHigherPriorityTaskWoken);
}

uint32_t eth_get_tx_ok(void)
{
    return eth_tx_ok;
}
uint32_t eth_get_tx_fail(void)
{
    return eth_tx_fail;
}
uint32_t eth_get_rx_frames(void)
{
    return eth_rx_frames;
}
