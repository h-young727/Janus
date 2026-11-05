/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define ACCEL_LSB_PER_G 16384.0f
#define GYRO_LSB_PER_DPS 131.0f
#define TELEMETRY_PERIOD_MS 100u
#define FILTER_ALPHA 0.98f
#define RAD_TO_DEG 57.29578f
#define MOTOR_PWM_MAX 65535.0f
#define RX_RING_SIZE 128u
#define LINE_SIZE 160u
/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
I2C_HandleTypeDef hi2c1;

TIM_HandleTypeDef htim3;

UART_HandleTypeDef huart2;

/* USER CODE BEGIN PV */
static uint16_t imu_addr = 0;
static float gyro_bias[3] = {0.0f, 0.0f, 0.0f};
static float tilt_deg = 0.0f;
static float motor_duty = 0.0f;
static volatile uint8_t rx_ring[RX_RING_SIZE];
static volatile uint16_t rx_head = 0;
static volatile uint16_t rx_tail = 0;
static volatile uint8_t rx_armed = 0;
static uint8_t rx_byte = 0;
static char line[LINE_SIZE];
static uint16_t line_len = 0;
static uint8_t line_overflow = 0;
/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM3_Init(void);
static void MX_I2C1_Init(void);
/* USER CODE BEGIN PFP */

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
static void uart_print(const char *s)
{
  HAL_UART_Transmit(&huart2, (uint8_t *)s, strlen(s), HAL_MAX_DELAY);
}

static void motor_apply(float duty)
{
  motor_duty = duty;
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_7, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);
  __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, (uint32_t)(duty / 100.0f * MOTOR_PWM_MAX));
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, duty > 0.0f ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void rx_arm(void)
{
  rx_armed = HAL_UART_Receive_IT(&huart2, &rx_byte, 1) == HAL_OK;
}

static void i2c_recover(void)
{
  GPIO_InitTypeDef scl = {0};
  SET_BIT(hi2c1.Instance->CR1, I2C_CR1_SWRST);
  CLEAR_BIT(hi2c1.Instance->CR1, I2C_CR1_SWRST);
  HAL_I2C_DeInit(&hi2c1);
  scl.Pin = GPIO_PIN_8;
  scl.Mode = GPIO_MODE_OUTPUT_OD;
  scl.Pull = GPIO_NOPULL;
  scl.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &scl);
  for (int i = 0; i < 9; i++)
  {
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_8, GPIO_PIN_RESET);
    HAL_Delay(1);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_8, GPIO_PIN_SET);
    HAL_Delay(1);
  }
  HAL_GPIO_DeInit(GPIOB, GPIO_PIN_8);
  MX_I2C1_Init();
}

static int imu_find(void)
{
  uint8_t wake = 0x00;
  imu_addr = 0;
  if (HAL_I2C_IsDeviceReady(&hi2c1, 0x68 << 1, 2, 20) == HAL_OK)
    imu_addr = 0x68 << 1;
  else if (HAL_I2C_IsDeviceReady(&hi2c1, 0x69 << 1, 2, 20) == HAL_OK)
    imu_addr = 0x69 << 1;
  if (imu_addr == 0)
    return 0;
  if (HAL_I2C_Mem_Write(&hi2c1, imu_addr, 0x6B, I2C_MEMADD_SIZE_8BIT, &wake, 1, 20) != HAL_OK)
  {
    imu_addr = 0;
    return 0;
  }
  HAL_Delay(50);
  return 1;
}

static int imu_read(float accel[3], float gyro[3])
{
  uint8_t raw[14];
  if (imu_addr == 0)
    return 0;
  if (HAL_I2C_Mem_Read(&hi2c1, imu_addr, 0x3B, I2C_MEMADD_SIZE_8BIT, raw, 14, 20) != HAL_OK)
    return 0;
  for (int i = 0; i < 3; i++)
  {
    accel[i] = (int16_t)(raw[2 * i] << 8 | raw[2 * i + 1]) / ACCEL_LSB_PER_G;
    gyro[i] = (int16_t)(raw[8 + 2 * i] << 8 | raw[9 + 2 * i]) / GYRO_LSB_PER_DPS - gyro_bias[i];
  }
  return 1;
}

static void gyro_calibrate(void)
{
  float sum[3] = {0.0f, 0.0f, 0.0f};
  float accel[3];
  float gyro[3];
  int count = 0;
  for (int i = 0; i < 3; i++)
    gyro_bias[i] = 0.0f;
  for (int n = 0; n < 200; n++)
  {
    if (imu_read(accel, gyro))
    {
      for (int i = 0; i < 3; i++)
        sum[i] += gyro[i];
      count++;
    }
    HAL_Delay(5);
  }
  if (count > 0)
    for (int i = 0; i < 3; i++)
      gyro_bias[i] = sum[i] / count;
  if (imu_read(accel, gyro))
    tilt_deg = atan2f(-accel[0], accel[2]) * RAD_TO_DEG;
}

static const char *json_value(const char *src, const char *key)
{
  char pattern[24];
  const char *p;
  snprintf(pattern, sizeof pattern, "\"%s\"", key);
  p = strstr(src, pattern);
  if (p == NULL)
    return NULL;
  p += strlen(pattern);
  while (*p == ' ')
    p++;
  if (*p != ':')
    return NULL;
  p++;
  while (*p == ' ')
    p++;
  return p;
}

static int json_string(const char *src, const char *key, char *out, size_t size)
{
  const char *p = json_value(src, key);
  size_t n = 0;
  if (p == NULL || *p != '"')
    return 0;
  p++;
  while (*p != '\0' && *p != '"' && n + 1 < size)
    out[n++] = *p++;
  if (*p != '"')
    return 0;
  out[n] = '\0';
  return 1;
}

static int json_number(const char *src, const char *key, float *out)
{
  const char *p = json_value(src, key);
  char *end;
  float value;
  if (p == NULL)
    return 0;
  value = strtof(p, &end);
  if (end == p)
    return 0;
  *out = value;
  return 1;
}

static void send_ack(const char *id, const char *error)
{
  char buf[160];
  if (error == NULL)
    snprintf(buf, sizeof buf, "{\"type\":\"ack\",\"id\":\"%s\",\"ok\":true}\r\n", id);
  else
    snprintf(buf, sizeof buf, "{\"type\":\"ack\",\"id\":\"%s\",\"ok\":false,\"error\":\"%s\"}\r\n", id, error);
  uart_print(buf);
}

static void handle_line(const char *text)
{
  char type[16];
  char id[48];
  char name[24];
  char error[48];
  float duty;
  if (!json_string(text, "type", type, sizeof type) || strcmp(type, "command") != 0)
    return;
  if (!json_string(text, "id", id, sizeof id))
    return;
  if (!json_string(text, "name", name, sizeof name))
  {
    send_ack(id, "missing name");
    return;
  }
  if (strcmp(name, "set_motor") == 0)
  {
    if (!json_number(text, "duty", &duty) || duty < 0.0f || duty > 100.0f)
    {
      send_ack(id, "duty must be between 0 and 100");
      return;
    }
    motor_apply(duty);
    send_ack(id, NULL);
  }
  else if (strcmp(name, "stop_motor") == 0)
  {
    motor_apply(0.0f);
    send_ack(id, NULL);
  }
  else
  {
    snprintf(error, sizeof error, "unknown command: %s", name);
    send_ack(id, error);
  }
}

static void poll_commands(void)
{
  while (rx_tail != rx_head)
  {
    char c = (char)rx_ring[rx_tail];
    rx_tail = (rx_tail + 1) % RX_RING_SIZE;
    if (c == '\n' || c == '\r')
    {
      if (line_len > 0 && !line_overflow)
      {
        line[line_len] = '\0';
        handle_line(line);
      }
      line_len = 0;
      line_overflow = 0;
    }
    else if ((uint16_t)(line_len + 1) < LINE_SIZE)
      line[line_len++] = c;
    else
      line_overflow = 1;
  }
  if (!rx_armed)
    rx_arm();
}

static void send_telemetry(const float accel[3], const float gyro[3])
{
  char buf[256];
  snprintf(buf, sizeof buf,
           "{\"type\":\"telemetry\",\"t\":%lu,\"data\":{\"tilt_deg\":%.2f,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f,\"motor_duty\":%.1f}}\r\n",
           (unsigned long)HAL_GetTick(), tilt_deg, accel[0], accel[1], accel[2], gyro[0], gyro[1], gyro[2], motor_duty);
  uart_print(buf);
}
/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM3_Init();
  MX_I2C1_Init();
  /* USER CODE BEGIN 2 */
  uint32_t next_tick;
  uint32_t last_sample;
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  motor_apply(0.0f);
  uart_print("\r\nJanus nucleo_tilt_motor\r\n");
  if (imu_find())
  {
    uart_print("IMU found, calibrating gyro, keep the board still\r\n");
    gyro_calibrate();
    uart_print("IMU ready\r\n");
  }
  else
    uart_print("IMU not found at 0x68 or 0x69, check wiring\r\n");
  rx_arm();
  next_tick = HAL_GetTick();
  last_sample = next_tick;
  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
    poll_commands();
    if ((int32_t)(HAL_GetTick() - next_tick) >= 0)
    {
      uint32_t now = HAL_GetTick();
      float accel[3];
      float gyro[3];
      next_tick += TELEMETRY_PERIOD_MS;
      if ((int32_t)(now - next_tick) >= 0)
        next_tick = now + TELEMETRY_PERIOD_MS;
      if (imu_read(accel, gyro))
      {
        float dt = (now - last_sample) / 1000.0f;
        float accel_tilt = atan2f(-accel[0], accel[2]) * RAD_TO_DEG;
        last_sample = now;
        if (dt > 0.5f)
          tilt_deg = accel_tilt;
        else
          tilt_deg = FILTER_ALPHA * (tilt_deg + gyro[1] * dt) + (1.0f - FILTER_ALPHA) * accel_tilt;
        send_telemetry(accel, gyro);
        HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
      }
      else
      {
        uart_print("IMU read failed, recovering I2C\r\n");
        i2c_recover();
        imu_find();
      }
    }
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE2);

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = 16;
  RCC_OscInitStruct.PLL.PLLN = 336;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV4;
  RCC_OscInitStruct.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2) != HAL_OK)
  {
    Error_Handler();
  }
}

/**
  * @brief I2C1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_I2C1_Init(void)
{

  /* USER CODE BEGIN I2C1_Init 0 */

  /* USER CODE END I2C1_Init 0 */

  /* USER CODE BEGIN I2C1_Init 1 */

  /* USER CODE END I2C1_Init 1 */
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN I2C1_Init 2 */

  /* USER CODE END I2C1_Init 2 */

}

/**
  * @brief TIM3 Initialization Function
  * @param None
  * @retval None
  */
static void MX_TIM3_Init(void)
{

  /* USER CODE BEGIN TIM3_Init 0 */

  /* USER CODE END TIM3_Init 0 */

  TIM_MasterConfigTypeDef sMasterConfig = {0};
  TIM_OC_InitTypeDef sConfigOC = {0};

  /* USER CODE BEGIN TIM3_Init 1 */

  /* USER CODE END TIM3_Init 1 */
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 0;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 65535;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }
  sMasterConfig.MasterOutputTrigger = TIM_TRGO_RESET;
  sMasterConfig.MasterSlaveMode = TIM_MASTERSLAVEMODE_DISABLE;
  if (HAL_TIMEx_MasterConfigSynchronization(&htim3, &sMasterConfig) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 0;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &sConfigOC, TIM_CHANNEL_1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN TIM3_Init 2 */

  /* USER CODE END TIM3_Init 2 */
  HAL_TIM_MspPostInit(&htim3);

}

/**
  * @brief USART2 Initialization Function
  * @param None
  * @retval None
  */
static void MX_USART2_UART_Init(void)
{

  /* USER CODE BEGIN USART2_Init 0 */

  /* USER CODE END USART2_Init 0 */

  /* USER CODE BEGIN USART2_Init 1 */

  /* USER CODE END USART2_Init 1 */
  huart2.Instance = USART2;
  huart2.Init.BaudRate = 115200;
  huart2.Init.WordLength = UART_WORDLENGTH_8B;
  huart2.Init.StopBits = UART_STOPBITS_1;
  huart2.Init.Parity = UART_PARITY_NONE;
  huart2.Init.Mode = UART_MODE_TX_RX;
  huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart2.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart2) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN USART2_Init 2 */

  /* USER CODE END USART2_Init 2 */

}

/**
  * @brief GPIO Initialization Function
  * @param None
  * @retval None
  */
static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  /* USER CODE BEGIN MX_GPIO_Init_1 */

  /* USER CODE END MX_GPIO_Init_1 */

  /* GPIO Ports Clock Enable */
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOH_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOA, LD2_Pin|GPIO_PIN_7, GPIO_PIN_RESET);

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_RESET);

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);

  /*Configure GPIO pin : B1_Pin */
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pins : LD2_Pin PA7 */
  GPIO_InitStruct.Pin = LD2_Pin|GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  /*Configure GPIO pin : PC7 */
  GPIO_InitStruct.Pin = GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  /*Configure GPIO pin : PB6 */
  GPIO_InitStruct.Pin = GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  /* USER CODE BEGIN MX_GPIO_Init_2 */

  /* USER CODE END MX_GPIO_Init_2 */
}

/* USER CODE BEGIN 4 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  uint16_t next;
  if (huart->Instance != USART2)
    return;
  next = (rx_head + 1) % RX_RING_SIZE;
  if (next != rx_tail)
  {
    rx_ring[rx_head] = rx_byte;
    rx_head = next;
  }
  rx_arm();
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
    rx_armed = 0;
}
/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
